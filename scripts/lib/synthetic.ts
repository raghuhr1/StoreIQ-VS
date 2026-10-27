/**
 * Deterministic synthetic RFID scan generator with known ground truth.
 *
 * SYNTHETIC DATA: validates engine logic only. The RF model below is a crude
 * simulation and is NOT evidence of real-world classification accuracy.
 */

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SyntheticFormat = "PER_READ" | "AGGREGATED" | "EPC_ONLY";

export interface SyntheticOptions {
  seed: number;
  itemCount: number;
  salesFloorShare?: number;
  /** Share of items near the boundary that can be cross-read. */
  boundaryShare?: number;
  crossReadProbability?: number;
  missProbability?: number;
  format?: SyntheticFormat;
  includeRssi?: boolean;
  includeTimestamps?: boolean;
  /** Start of the Sales Floor scan (UTC ms). The Back Room scan starts gapMinutes after it ends. */
  startMs?: number;
  gapMinutes?: number;
  epcPrefix?: string;
}

export interface SyntheticRow {
  epc: string;
  zone: "SALES_FLOOR" | "BACK_ROOM";
  session: string;
  timestamp?: string;
  rssi?: number;
  readCount?: number;
}

export interface SyntheticResult {
  rows: SyntheticRow[];
  truth: { epc: string; zone: "SALES_FLOOR" | "BACK_ROOM"; boundary: boolean }[];
}

function gaussian(rand: () => number, mean: number, sd: number) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function poisson(rand: () => number, lambda: number) {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l);
  return k - 1;
}

export function epcFor(prefix: string, i: number) {
  // 96-bit EPC (24 hex chars).
  const p = prefix.slice(0, 6).padEnd(6, "0");
  return p + i.toString(16).toUpperCase().padStart(18, "0");
}

export function generateScans(opts: SyntheticOptions): SyntheticResult {
  const rand = mulberry32(opts.seed);
  const sfShare = opts.salesFloorShare ?? 0.7;
  const boundaryShare = opts.boundaryShare ?? 0.15;
  const crossP = opts.crossReadProbability ?? 0.6;
  const missP = opts.missProbability ?? 0.01;
  const format = opts.format ?? "PER_READ";
  const includeRssi = opts.includeRssi ?? true;
  const includeTs = opts.includeTimestamps ?? true;
  const start = opts.startMs ?? Date.UTC(2026, 9, 1, 9, 0, 0);
  const sfDur = 20 * 60_000;
  const brStart = start + sfDur + (opts.gapMinutes ?? 10) * 60_000;
  const brDur = 15 * 60_000;
  const prefix = opts.epcPrefix ?? "E28011";

  const truth: SyntheticResult["truth"] = [];
  for (let i = 0; i < opts.itemCount; i++)
    truth.push({
      epc: epcFor(prefix, i + 1),
      zone: rand() < sfShare ? "SALES_FLOOR" : "BACK_ROOM",
      boundary: rand() < boundaryShare,
    });

  const rows: SyntheticRow[] = [];
  const scan = (zone: "SALES_FLOOR" | "BACK_ROOM", session: string, t0: number, dur: number) => {
    for (const item of truth) {
      const genuine = item.zone === zone;
      if (genuine && rand() < missP) continue;
      if (!genuine && !(item.boundary && rand() < crossP)) continue;
      const reads = genuine ? Math.max(1, poisson(rand, 8)) : Math.max(1, poisson(rand, 1.5));
      const mean = genuine ? -50 : -72;
      if (format === "PER_READ") {
        for (let r = 0; r < reads; r++)
          rows.push({
            epc: item.epc,
            zone,
            session,
            timestamp: includeTs ? new Date(t0 + Math.floor(rand() * dur)).toISOString() : undefined,
            rssi: includeRssi ? Math.round(gaussian(rand, mean, genuine ? 6 : 5) * 10) / 10 : undefined,
          });
      } else if (format === "AGGREGATED") {
        let best = -200;
        for (let r = 0; r < reads; r++) best = Math.max(best, gaussian(rand, mean, genuine ? 6 : 5));
        rows.push({
          epc: item.epc,
          zone,
          session,
          readCount: reads,
          rssi: includeRssi ? Math.round(best * 10) / 10 : undefined,
          timestamp: includeTs ? new Date(t0 + Math.floor(rand() * dur)).toISOString() : undefined,
        });
      } else rows.push({ epc: item.epc, zone, session });
    }
  };
  scan("SALES_FLOOR", "SF-SCAN-1", start, sfDur);
  scan("BACK_ROOM", "BR-SCAN-1", brStart, brDur);
  return { rows, truth };
}

function cell(v: unknown) {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render rows as CSV with RFD40-style headers (header names are illustrative, not a real Zebra spec). */
export function toScanCsv(rows: SyntheticRow[], opts: { combined: boolean; eol?: string }): string {
  const eol = opts.eol ?? "\n";
  const sample = rows[0] ?? ({} as SyntheticRow);
  const cols: [string, (r: SyntheticRow) => unknown][] = [["EPC", (r) => r.epc]];
  if (opts.combined)
    cols.push(
      ["Zone", (r) => (r.zone === "SALES_FLOOR" ? "Sales Floor" : "Back Room")],
      ["Session ID", (r) => r.session],
    );
  if (sample.timestamp !== undefined) cols.push(["Timestamp", (r) => r.timestamp]);
  if (sample.rssi !== undefined) cols.push(["Peak RSSI", (r) => r.rssi]);
  if (sample.readCount !== undefined) cols.push(["Read Count", (r) => r.readCount]);
  return (
    [cols.map((c) => c[0]).join(","), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(","))].join(
      eol,
    ) + eol
  );
}
