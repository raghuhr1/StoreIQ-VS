import { toCsv, type Cell } from "./csv";
import { EXPORT_SCHEMA_VERSION } from "./profile";
import type { OperationalMetrics, RowStats } from "./metrics";
import { formatTimestamp } from "./timestamps";
import type { AggregationResult, ClassificationResult, ZoneRef } from "./types";

export interface ExportFile {
  kind: string;
  filename: string;
  content: string;
  rowCount: number;
}

export interface ExportContext {
  jobId: string;
  storeId: string;
  profileVersion: string;
  zones: ZoneRef[];
  aggregation: AggregationResult;
  results: ClassificationResult[];
  metrics: OperationalMetrics;
  rowStats: RowStats;
  processingStatus: string;
  createdAt: number;
  completedAt: number | null;
}

export const OBSERVED_COLUMNS = [
  "job_id",
  "store_id",
  "scan_session_id",
  "epc",
  "observed_zone",
  "raw_read_count",
  "first_seen",
  "last_seen",
  "median_rssi",
  "data_quality_status",
] as const;

export const CLEANED_COLUMNS = [
  "job_id",
  "store_id",
  "epc",
  "assigned_zone",
  "confidence_score",
  "confidence_type",
  "classification_reason",
  "processing_profile_version",
] as const;

export const EXCEPTION_COLUMNS = [
  "job_id",
  "store_id",
  "epc",
  "observed_zones",
  "classification",
  "confidence_score",
  "confidence_type",
  "reason_code",
  "reason_description",
  "recommended_action",
  "evidence_available",
  "requires_manual_review",
  // Additional columns (appended to keep the required ones stable):
  "affected_zone",
  "suggested_zone",
] as const;

export const SUMMARY_COLUMNS = [
  "job_id",
  "store_id",
  "input_file_count",
  "input_row_count",
  "valid_row_count",
  "invalid_row_count",
  "unique_epc_count",
  "duplicate_observation_count",
  "accepted_count_by_zone",
  "review_count",
  "rejected_from_zone_count",
  "multi_zone_epc_count",
  "processing_status",
  "processing_profile_version",
  "created_at",
  "completed_at",
  // Additional columns:
  "anchor_epc_count",
  "malformed_epc_count",
  "schema_version",
] as const;

const KIND_FILENAMES: Record<string, string> = {
  observed_inventory: "observed_inventory.csv",
  cleaned_sales_floor: "cleaned_sales_floor.csv",
  cleaned_back_room: "cleaned_back_room.csv",
  exceptions: "exceptions.csv",
  processing_summary: "processing_summary.csv",
};

/** Build all output files from one saved processing result. Deterministic. */
export function buildExports(ctx: ExportContext): ExportFile[] {
  const zoneById = new Map(ctx.zones.map((z) => [z.id, z]));
  const zc = (id: string | null) => (id ? (zoneById.get(id)?.code ?? id) : "");
  const sessionExt = new Map(ctx.aggregation.sessions.map((s) => [s.key, s.externalId]));
  const files: ExportFile[] = [];

  // A. Observed inventory: one row per unique EPC per observed zone.
  const observedRows: Cell[][] = [];
  for (const e of ctx.aggregation.epcs)
    for (const z of e.zones)
      observedRows.push([
        ctx.jobId,
        ctx.storeId,
        z.sessionKeys.map((k) => sessionExt.get(k) ?? k).join("|"),
        e.epc,
        zc(z.zoneId),
        z.rawReadCount,
        formatTimestamp(z.firstSeen),
        formatTimestamp(z.lastSeen),
        z.rssi ? z.rssi.median : null,
        z.dataQualityStatus,
      ]);
  files.push(file("observed_inventory", OBSERVED_COLUMNS, observedRows));

  // B/C. Cleaned inventory per zone type, plus one file per other zone.
  const cleanedRow = (r: ClassificationResult): Cell[] => [
    ctx.jobId,
    ctx.storeId,
    r.epc,
    zc(r.assignedZoneId),
    r.confidenceScore,
    r.confidenceType,
    r.reasonCode,
    ctx.profileVersion,
  ];
  const accepted = ctx.results.filter((r) => r.classification === "ACCEPTED");
  const ofType = (t: string) =>
    accepted.filter((r) => zoneById.get(r.assignedZoneId!)?.type === t).map(cleanedRow);
  files.push(file("cleaned_sales_floor", CLEANED_COLUMNS, ofType("SALES_FLOOR")));
  files.push(file("cleaned_back_room", CLEANED_COLUMNS, ofType("BACK_ROOM")));
  const otherZones = [...ctx.zones]
    .filter((z) => z.type !== "SALES_FLOOR" && z.type !== "BACK_ROOM")
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : 1));
  for (const z of otherZones) {
    const rows = accepted.filter((r) => r.assignedZoneId === z.id).map(cleanedRow);
    const safe = z.code
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .slice(0, 40);
    files.push({
      ...file(`cleaned_zone_${safe}`, CLEANED_COLUMNS, rows),
      filename: `cleaned_zone_${safe}.csv`,
    });
  }

  // D. Exceptions: review items, primary exclusions and per-zone exclusions.
  const exRows: Cell[][] = [];
  for (const r of ctx.results) {
    const observed = r.observedZoneIds.map(zc).join("|");
    const common = (
      classification: string,
      reasonCode: string,
      description: string,
      action: string,
      manual: boolean,
      zone: string | null,
    ): Cell[] => [
      ctx.jobId,
      ctx.storeId,
      r.epc,
      observed,
      classification,
      r.confidenceScore,
      r.confidenceType,
      reasonCode,
      description,
      action,
      r.evidenceAvailable.join("|"),
      manual,
      zone ? zc(zone) : "",
      zc(r.suggestedZoneId),
    ];
    if (r.classification !== "ACCEPTED") {
      const zone = r.classification === "REJECTED_FROM_ZONE" ? r.observedZoneIds[0] : null;
      exRows.push(
        common(r.classification, r.reasonCode, r.reasonDescription, r.recommendedAction, true, zone),
      );
      continue;
    }
    for (const d of r.zoneDispositions)
      if (d.disposition === "REJECTED_FROM_ZONE")
        exRows.push(
          common(
            "REJECTED_FROM_ZONE",
            d.reasonCode,
            `Excluded from ${zoneById.get(d.zoneId)?.name ?? zc(d.zoneId)} as a likely cross-read; accepted in ${zoneById.get(r.assignedZoneId!)?.name ?? zc(r.assignedZoneId)}`,
            "None. The item is counted in its accepted zone only.",
            false,
            d.zoneId,
          ),
        );
  }
  files.push(file("exceptions", EXCEPTION_COLUMNS, exRows));

  // E. Processing summary.
  const m = ctx.metrics;
  const acceptedByZone = Object.entries(m.acceptedByZone)
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
  files.push(
    file("processing_summary", SUMMARY_COLUMNS, [
      [
        ctx.jobId,
        ctx.storeId,
        ctx.rowStats.inputFileCount,
        ctx.rowStats.inputRowCount,
        ctx.rowStats.validRowCount,
        ctx.rowStats.invalidRowCount,
        m.uniqueEpcCount,
        m.duplicateObservationCount,
        acceptedByZone,
        m.reviewCount,
        m.rejectedFromZoneCount,
        m.multiZoneEpcCount,
        ctx.processingStatus,
        ctx.profileVersion,
        formatTimestamp(ctx.createdAt),
        formatTimestamp(ctx.completedAt),
        m.anchorEpcCount,
        m.malformedEpcCount,
        EXPORT_SCHEMA_VERSION,
      ],
    ]),
  );
  return files;
}

function file(kind: string, header: readonly string[], rows: Cell[][]): ExportFile {
  return {
    kind,
    filename: KIND_FILENAMES[kind] ?? `${kind}.csv`,
    content: toCsv(header, rows),
    rowCount: rows.length,
  };
}
