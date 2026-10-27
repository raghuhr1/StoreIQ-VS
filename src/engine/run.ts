import { Aggregator } from "./aggregate";
import { classifyAll } from "./classify";
import { readCsv, type CsvDelimiter } from "./csv-input";
import { computeOperationalMetrics, type OperationalMetrics, type RowStats } from "./metrics";
import type { ProcessingProfileConfig } from "./profile";
import { createRowMapper, type MappedRow } from "./rows";
import type {
  AggregationResult,
  AnchorRef,
  ClassificationResult,
  FileContext,
  Observation,
  RowIssue,
  ZoneRef,
  ZoneRelationshipRef,
} from "./types";

export interface EngineConfig {
  profile: ProcessingProfileConfig;
  zones: ZoneRef[];
  relationships: ZoneRelationshipRef[];
  anchors: AnchorRef[];
}

export interface RecordOutcome extends MappedRow {
  duplicate: boolean;
  anchor: boolean;
}

export interface EngineOutput {
  aggregation: AggregationResult;
  results: ClassificationResult[];
  metrics: OperationalMetrics;
  rowStats: RowStats;
}

/**
 * One deterministic processing run. Feed files in a stable order, then call
 * finish(). Identical inputs and configuration give identical outputs.
 */
export class EngineRun {
  private aggregator: Aggregator;
  private mapper: ((record: string[], rowNumber: number) => MappedRow) | null = null;
  private stats: RowStats = {
    inputFileCount: 0,
    inputRowCount: 0,
    validRowCount: 0,
    invalidRowCount: 0,
    warningCount: 0,
    issueCounts: {},
  };

  constructor(private config: EngineConfig) {
    this.aggregator = new Aggregator(config.profile, config.zones, config.anchors);
  }

  beginFile(file: FileContext, headers: string[]) {
    this.stats.inputFileCount++;
    this.aggregator.registerFile(file.uploadId, {
      readCountMapped: !!file.mapping.readCount,
      timestampMapped: !!file.mapping.timestamp,
    });
    this.mapper = createRowMapper(file, headers, this.config.zones, this.config.profile);
  }

  private count(issues: RowIssue[]) {
    for (const i of issues) {
      this.stats.issueCounts[i.code] = (this.stats.issueCounts[i.code] ?? 0) + 1;
      if (i.severity === "warning") this.stats.warningCount++;
    }
  }

  addRecord(record: string[], rowNumber: number): RecordOutcome {
    if (!this.mapper) throw new Error("beginFile() must be called before addRecord()");
    this.stats.inputRowCount++;
    const mapped = this.mapper(record, rowNumber);
    this.count(mapped.issues);
    if (!mapped.observation) {
      this.stats.invalidRowCount++;
      return { ...mapped, duplicate: false, anchor: false };
    }
    this.stats.validRowCount++;
    const r = this.aggregator.add(mapped.observation);
    return { ...mapped, ...r };
  }

  /** Record a row the CSV parser could not read at all. */
  addMalformed(uploadId: string, rowNumber: number, message: string): RowIssue {
    this.stats.inputRowCount++;
    this.stats.invalidRowCount++;
    const issue: RowIssue = { uploadId, rowNumber, code: "MALFORMED_ROW", message, severity: "error" };
    this.count([issue]);
    return issue;
  }

  get rowStats(): RowStats {
    return this.stats;
  }

  finish(): EngineOutput {
    const aggregation = this.aggregator.finalize();
    const results = classifyAll({
      profile: this.config.profile,
      zones: this.config.zones,
      relationships: this.config.relationships,
      aggregation,
    });
    return {
      aggregation,
      results,
      metrics: computeOperationalMetrics(aggregation, results, this.config.zones),
      rowStats: { ...this.stats, issueCounts: { ...this.stats.issueCounts } },
    };
  }
}

export interface CsvFileInput {
  file: FileContext;
  delimiter: CsvDelimiter;
  source: AsyncIterable<Uint8Array | string>;
}

/**
 * Convenience runner over CSV sources (used by tests, validation previews and
 * the benchmark). The worker uses EngineRun directly to persist rows in batches.
 */
export async function runCsv(
  config: EngineConfig,
  inputs: CsvFileInput[],
  onObservation?: (o: Observation, outcome: RecordOutcome) => void,
): Promise<EngineOutput & { issues: RowIssue[] }> {
  const run = new EngineRun(config);
  const issues: RowIssue[] = [];
  for (const input of inputs) {
    for await (const item of readCsv(input.source, input.delimiter)) {
      if (item.kind === "header") run.beginFile(input.file, item.headers);
      else if (item.kind === "malformed")
        issues.push(run.addMalformed(input.file.uploadId, item.rowNumber, item.message));
      else {
        const out = run.addRecord(item.record, item.rowNumber);
        issues.push(...out.issues);
        if (out.observation && onObservation) onObservation(out.observation, out);
      }
    }
  }
  return { ...run.finish(), issues };
}
