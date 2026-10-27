import type { GroundTruthLabelInput } from "./metrics";
import type { AggregationResult, ZoneRef } from "./types";

export const MIN_CALIBRATION_SAMPLES = 30;

export interface ZoneThresholdSuggestion {
  zoneCode: string;
  genuineCount: number;
  crossReadCount: number;
  genuineP10: number | null;
  crossReadP90: number | null;
  suggestedWeakRssiThreshold: number | null;
  note: string;
}

export interface CalibrationSuggestion {
  zones: ZoneThresholdSuggestion[];
  multiZone: {
    labeledCount: number;
    rssiMarginP10: number | null;
    misleadingRssiCount: number;
    note: string;
  };
  sufficient: boolean;
}

function pct(sorted: number[], q: number) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)) * 10) / 10;
}

/**
 * Suggest store-specific RSSI thresholds from labeled calibration data.
 * Suggestions are advisory: an administrator must review them and save a new
 * profile version. They use only human-provided labels, never the engine's own
 * predictions. Evaluate any tuned profile on a *different* scan job.
 */
export function suggestCalibration(
  agg: AggregationResult,
  labels: GroundTruthLabelInput[],
  zones: ZoneRef[],
): CalibrationSuggestion {
  const actual = new Map(labels.map((l) => [l.epc, l.actualZoneId]));
  const genuine = new Map<string, number[]>();
  const cross = new Map<string, number[]>();
  const margins: number[] = [];
  let multiLabeled = 0;
  for (const e of agg.epcs) {
    const truth = actual.get(e.epc);
    if (!truth) continue;
    for (const z of e.zones) {
      if (!z.rssi) continue;
      const target = z.zoneId === truth ? genuine : cross;
      if (!target.has(z.zoneId)) target.set(z.zoneId, []);
      target.get(z.zoneId)!.push(z.rssi.median);
    }
    if (e.zones.length > 1) {
      const t = e.zones.find((z) => z.zoneId === truth);
      const others = e.zones.filter((z) => z.zoneId !== truth && z.rssi);
      if (t?.rssi && others.length) {
        multiLabeled++;
        margins.push(t.rssi.median - Math.max(...others.map((o) => o.rssi!.median)));
      }
    }
  }
  const zoneOut: ZoneThresholdSuggestion[] = zones.map((z) => {
    const g = (genuine.get(z.id) ?? []).sort((a, b) => a - b);
    const c = (cross.get(z.id) ?? []).sort((a, b) => a - b);
    const gP10 = pct(g, 0.1);
    const cP90 = pct(c, 0.9);
    let suggested: number | null = null;
    let note: string;
    if (g.length < MIN_CALIBRATION_SAMPLES || c.length < MIN_CALIBRATION_SAMPLES)
      note = `Insufficient labeled samples (need >= ${MIN_CALIBRATION_SAMPLES} genuine and cross-read examples).`;
    else if (gP10! > cP90!) {
      suggested = Math.round(((gP10! + cP90!) / 2) * 10) / 10;
      note = "Genuine and cross-read RSSI are separable at the 10th/90th percentiles.";
    } else note = "Genuine and cross-read RSSI distributions overlap; a single threshold is not recommended.";
    return {
      zoneCode: z.code,
      genuineCount: g.length,
      crossReadCount: c.length,
      genuineP10: gP10,
      crossReadP90: cP90,
      suggestedWeakRssiThreshold: suggested,
      note,
    };
  });
  margins.sort((a, b) => a - b);
  const misleading = margins.filter((m) => m <= 0).length;
  return {
    zones: zoneOut,
    multiZone: {
      labeledCount: multiLabeled,
      rssiMarginP10: pct(margins, 0.1),
      misleadingRssiCount: misleading,
      note:
        multiLabeled < MIN_CALIBRATION_SAMPLES
          ? `Insufficient labeled multi-zone EPCs (need >= ${MIN_CALIBRATION_SAMPLES}).`
          : `${misleading} of ${multiLabeled} labeled multi-zone EPCs had equal or stronger RSSI in the wrong zone.`,
    },
    sufficient:
      zoneOut.some((z) => z.suggestedWeakRssiThreshold !== null) || multiLabeled >= MIN_CALIBRATION_SAMPLES,
  };
}
