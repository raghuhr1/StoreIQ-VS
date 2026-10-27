import type { AggregationResult, ClassificationResult, ZoneRef } from "./types";

export interface RowStats {
  inputFileCount: number;
  inputRowCount: number;
  validRowCount: number;
  invalidRowCount: number;
  warningCount: number;
  issueCounts: Record<string, number>;
}

export interface OperationalMetrics {
  uniqueEpcCount: number;
  anchorEpcCount: number;
  malformedEpcCount: number;
  multiZoneEpcCount: number;
  multiZoneOverlapRate: number | null;
  acceptedCount: number;
  reviewCount: number;
  rejectedPrimaryCount: number;
  rejectedFromZoneCount: number;
  uncertainRate: number | null;
  classificationCoverage: number | null;
  missingUsefulEvidenceRate: number | null;
  observedByZone: Record<string, number>;
  acceptedByZone: Record<string, number>;
  rejectedFromZoneByZone: Record<string, number>;
  excludedRateByZone: Record<string, number | null>;
  reasonCounts: Record<string, number>;
  confidenceTypeCounts: Record<string, number>;
  duplicateObservationCount: number;
}

const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10000) / 10000);
const inc = (m: Record<string, number>, k: string, by = 1) => (m[k] = (m[k] ?? 0) + by);

/** Metrics that need no ground truth. These are NOT accuracy measures. */
export function computeOperationalMetrics(
  agg: AggregationResult,
  results: ClassificationResult[],
  zones: ZoneRef[],
): OperationalMetrics {
  const code = new Map(zones.map((z) => [z.id, z.code]));
  const observedByZone: Record<string, number> = {};
  const acceptedByZone: Record<string, number> = {};
  const rejectedByZone: Record<string, number> = {};
  for (const z of zones) {
    observedByZone[z.code] = 0;
    acceptedByZone[z.code] = 0;
    rejectedByZone[z.code] = 0;
  }
  const reasonCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  let accepted = 0;
  let review = 0;
  let rejectedPrimary = 0;
  let rejectedFromZone = 0;
  let multi = 0;
  let missingEvidence = 0;
  let malformed = 0;
  for (const r of results) {
    for (const z of r.observedZoneIds) inc(observedByZone, code.get(z) ?? z);
    if (r.observedZoneIds.length > 1) multi++;
    if (r.reasonCode === "MALFORMED_EPC") malformed++;
    inc(reasonCounts, r.reasonCode);
    inc(typeCounts, r.confidenceType);
    if (r.classification === "ACCEPTED") {
      accepted++;
      inc(acceptedByZone, code.get(r.assignedZoneId!) ?? r.assignedZoneId!);
    } else if (r.classification === "NEEDS_REVIEW") review++;
    else rejectedPrimary++;
    for (const d of r.zoneDispositions)
      if (d.disposition === "REJECTED_FROM_ZONE") {
        rejectedFromZone++;
        inc(rejectedByZone, code.get(d.zoneId) ?? d.zoneId);
      }
    if (!r.evidenceAvailable.some((e) => e === "RSSI" || e === "TIMESTAMPS" || e === "READ_COUNTS"))
      missingEvidence++;
  }
  const n = results.length;
  const excludedRateByZone: Record<string, number | null> = {};
  for (const [z, obs] of Object.entries(observedByZone))
    excludedRateByZone[z] = ratio(rejectedByZone[z] ?? 0, obs);
  return {
    uniqueEpcCount: n,
    anchorEpcCount: agg.anchorEpcs.length,
    malformedEpcCount: malformed,
    multiZoneEpcCount: multi,
    multiZoneOverlapRate: ratio(multi, n),
    acceptedCount: accepted,
    reviewCount: review,
    rejectedPrimaryCount: rejectedPrimary,
    rejectedFromZoneCount: rejectedFromZone,
    uncertainRate: ratio(review, n),
    classificationCoverage: ratio(n - review, n),
    missingUsefulEvidenceRate: ratio(missingEvidence, n),
    observedByZone,
    acceptedByZone,
    rejectedFromZoneByZone: rejectedByZone,
    excludedRateByZone,
    reasonCounts,
    confidenceTypeCounts: typeCounts,
    duplicateObservationCount: agg.stats.duplicateObservationCount,
  };
}

export interface GroundTruthLabelInput {
  epc: string; // normalized
  actualZoneId: string;
  category?: string;
}

export interface ZoneEvaluation {
  groundTruthCount: number;
  truePositives: number;
  acceptedLabeled: number;
  falseAcceptances: number;
  recall: number | null;
  precision: number | null;
  falseAcceptanceRate: number | null;
  rawRecall: number | null;
  rawFalseAcceptanceRate: number | null;
  reviewCount: number;
}

export interface EvaluationReport {
  labeledCount: number;
  labeledObservedCount: number;
  labeledNotObservedCount: number;
  labelsForUnknownZones: number;
  perZone: Record<string, ZoneEvaluation>;
  overall: { recall: number | null; precision: number | null; falseAcceptanceRate: number | null };
  uncertainRate: number | null;
  classificationCoverage: number | null;
  confusion: { actual: string[]; predicted: string[]; counts: number[][] };
  byCategory: Record<
    string,
    { total: number; correct: number; incorrect: number; review: number; notObserved: number }
  >;
}

/**
 * Evaluate classifications against independently labeled ground truth.
 * Labels are only read here, after classification, so they cannot leak into
 * inference.
 *
 * Genuine-item recall (zone z): labeled EPCs truly in z that were accepted
 * into z, divided by all labeled EPCs truly in z (including unobserved ones).
 * Cross-zone false acceptance rate (zone z): among labeled EPCs accepted into
 * z, the share whose true zone is not z.
 */
export function evaluate(
  results: ClassificationResult[],
  labels: GroundTruthLabelInput[],
  zones: ZoneRef[],
): EvaluationReport {
  const zoneCodes = zones.map((z) => z.code);
  const code = new Map(zones.map((z) => [z.id, z.code]));
  const byEpc = new Map(results.map((r) => [r.epc, r]));
  const labelMap = new Map<string, GroundTruthLabelInput>();
  let unknownZone = 0;
  for (const l of labels) {
    if (!code.has(l.actualZoneId)) {
      unknownZone++;
      continue;
    }
    labelMap.set(l.epc, l);
  }

  const predictedCols = [...zoneCodes, "NEEDS_REVIEW", "REJECTED_ONLY", "NOT_OBSERVED"];
  const counts = zoneCodes.map(() => predictedCols.map(() => 0));
  const perZone: Record<string, ZoneEvaluation> = {};
  for (const z of zoneCodes)
    perZone[z] = {
      groundTruthCount: 0,
      truePositives: 0,
      acceptedLabeled: 0,
      falseAcceptances: 0,
      recall: null,
      precision: null,
      falseAcceptanceRate: null,
      rawRecall: null,
      rawFalseAcceptanceRate: null,
      reviewCount: 0,
    };
  const rawObservedTrue: Record<string, number> = {};
  const rawObservedLabeled: Record<string, number> = {};
  const byCategory: EvaluationReport["byCategory"] = {};
  let observed = 0;
  let review = 0;

  for (const l of labelMap.values()) {
    const actual = code.get(l.actualZoneId)!;
    const r = byEpc.get(l.epc);
    const cat = (byCategory[l.category ?? "KNOWN_LOCATION"] ??= {
      total: 0,
      correct: 0,
      incorrect: 0,
      review: 0,
      notObserved: 0,
    });
    cat.total++;
    perZone[actual].groundTruthCount++;
    let col: string;
    if (!r) {
      col = "NOT_OBSERVED";
      cat.notObserved++;
    } else {
      observed++;
      for (const zid of r.observedZoneIds) {
        const zc = code.get(zid)!;
        rawObservedLabeled[zc] = (rawObservedLabeled[zc] ?? 0) + 1;
        if (zc === actual) rawObservedTrue[zc] = (rawObservedTrue[zc] ?? 0) + 1;
      }
      if (r.classification === "ACCEPTED") {
        const pred = code.get(r.assignedZoneId!)!;
        col = pred;
        perZone[pred].acceptedLabeled++;
        if (pred === actual) {
          perZone[pred].truePositives++;
          cat.correct++;
        } else {
          perZone[pred].falseAcceptances++;
          cat.incorrect++;
        }
      } else if (r.classification === "NEEDS_REVIEW") {
        col = "NEEDS_REVIEW";
        review++;
        perZone[actual].reviewCount++;
        cat.review++;
      } else {
        col = "REJECTED_ONLY";
        cat.incorrect++;
      }
    }
    counts[zoneCodes.indexOf(actual)][predictedCols.indexOf(col)]++;
  }

  let tp = 0;
  let gt = 0;
  let acc = 0;
  let fa = 0;
  for (const z of zoneCodes) {
    const e = perZone[z];
    e.recall = ratio(e.truePositives, e.groundTruthCount);
    e.precision = ratio(e.truePositives, e.acceptedLabeled);
    e.falseAcceptanceRate = ratio(e.falseAcceptances, e.acceptedLabeled);
    e.rawRecall = ratio(rawObservedTrue[z] ?? 0, e.groundTruthCount);
    e.rawFalseAcceptanceRate = ratio(
      (rawObservedLabeled[z] ?? 0) - (rawObservedTrue[z] ?? 0),
      rawObservedLabeled[z] ?? 0,
    );
    tp += e.truePositives;
    gt += e.groundTruthCount;
    acc += e.acceptedLabeled;
    fa += e.falseAcceptances;
  }
  return {
    labeledCount: labelMap.size,
    labeledObservedCount: observed,
    labeledNotObservedCount: labelMap.size - observed,
    labelsForUnknownZones: unknownZone,
    perZone,
    overall: { recall: ratio(tp, gt), precision: ratio(tp, acc), falseAcceptanceRate: ratio(fa, acc) },
    uncertainRate: ratio(review, observed),
    classificationCoverage: ratio(observed - review, observed),
    confusion: { actual: zoneCodes, predicted: predictedCols, counts },
    byCategory,
  };
}
