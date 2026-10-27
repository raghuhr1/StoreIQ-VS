import {
  CANONICAL_FIELDS,
  type CanonicalField,
  type ColumnMapping,
  type ZoneRef,
  type ZoneType,
} from "./types";

/** Known header aliases per canonical field (compared after normalizeHeader). */
export const FIELD_ALIASES: Record<CanonicalField, string[]> = {
  epc: [
    "epc",
    "epc id",
    "epcid",
    "epc hex",
    "epc value",
    "epc code",
    "tag",
    "tag id",
    "tagid",
    "tag epc",
    "rfid",
    "rfid tag",
    "rfid tag id",
    "rfid id",
    "tag data",
    "uii",
  ],
  zone: [
    "zone",
    "zone name",
    "zone id",
    "zone code",
    "location",
    "location name",
    "area",
    "store zone",
    "scan zone",
    "loc",
    "sublocation",
  ],
  session: [
    "session",
    "session id",
    "scan session",
    "scan session id",
    "scan id",
    "inventory id",
    "count id",
    "cycle count id",
    "batch",
    "batch id",
    "job id",
    "task id",
  ],
  timestamp: [
    "timestamp",
    "time stamp",
    "time",
    "datetime",
    "date time",
    "read time",
    "seen time",
    "scan time",
    "read timestamp",
    "event time",
    "last seen",
    "last seen time",
    "date",
  ],
  rssi: [
    "rssi",
    "peak rssi",
    "peakrssi",
    "rssi dbm",
    "signal",
    "signal strength",
    "avg rssi",
    "average rssi",
  ],
  readCount: [
    "read count",
    "readcount",
    "reads",
    "count",
    "seen count",
    "tag seen count",
    "times seen",
    "number of reads",
    "read cnt",
  ],
  phase: ["phase", "phase angle", "phase radians", "phase degrees"],
  readerId: [
    "reader",
    "reader id",
    "reader name",
    "device",
    "device id",
    "device name",
    "scanner",
    "scanner id",
    "handheld id",
    "serial",
    "serial number",
  ],
  antennaId: ["antenna", "antenna id", "ant", "antenna port", "port"],
  channel: ["channel", "channel index", "frequency", "freq", "frequency mhz"],
  txPower: ["tx power", "txpower", "transmit power", "power", "power level", "tx power dbm"],
  anchorFlag: ["anchor", "is anchor", "anchor tag", "anchor flag", "reference tag", "is reference"],
};

export const FIELD_LABELS: Record<CanonicalField, string> = {
  epc: "EPC / RFID tag ID",
  zone: "Zone",
  session: "Scan session",
  timestamp: "Timestamp",
  rssi: "RSSI (dBm)",
  readCount: "Read count",
  phase: "Phase",
  readerId: "Reader ID",
  antennaId: "Antenna ID",
  channel: "Channel",
  txPower: "Transmit power",
  anchorFlag: "Anchor-tag indicator",
};

export function normalizeHeader(h: string): string {
  return h
    .replace(/^﻿/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const valueChecks: Partial<Record<CanonicalField, (v: string) => boolean>> = {
  epc: (v) => /^(0x)?[0-9a-f\s:-]{16,}$/i.test(v.trim()),
  rssi: (v) => /^-\d{1,3}(\.\d+)?$/.test(v.trim()) && Number(v) >= -120,
  readCount: (v) => /^\d{1,6}$/.test(v.trim()),
  timestamp: (v) => /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.]\d{1,2}[/.]\d{4}|^\d{10}(\d{3})?$/.test(v.trim()),
  anchorFlag: (v) => /^(true|false|yes|no|y|n|0|1)$/i.test(v.trim()),
};

export interface MappingSuggestion {
  mapping: ColumnMapping;
  /** Field -> 0..1 confidence of the suggestion (for UI display only). */
  scores: Partial<Record<CanonicalField, number>>;
  unmappedColumns: string[];
}

/** Suggest a column mapping from header names and sample values. Deterministic. */
export function suggestMapping(headers: string[], sampleRows: string[][]): MappingSuggestion {
  const candidates: { field: CanonicalField; col: number; score: number }[] = [];
  headers.forEach((header, col) => {
    const nh = normalizeHeader(header);
    if (!nh) return;
    const samples = sampleRows.map((r) => r[col] ?? "").filter((v) => v.trim() !== "");
    for (const field of CANONICAL_FIELDS) {
      const aliases = FIELD_ALIASES[field];
      let score = 0;
      if (aliases.includes(nh)) score = 1;
      else if (aliases.some((a) => a.length >= 3 && (nh.startsWith(a + " ") || nh.endsWith(" " + a))))
        score = 0.6;
      const check = valueChecks[field];
      if (check && samples.length > 0) {
        const ratio = samples.filter(check).length / samples.length;
        if (score > 0) score = ratio >= 0.8 ? Math.min(1, score + 0.2) : ratio < 0.2 ? score * 0.5 : score;
        else if (field === "epc" && ratio >= 0.9) score = 0.5;
      }
      if (score > 0) candidates.push({ field, col, score });
    }
  });
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.col - b.col ||
      CANONICAL_FIELDS.indexOf(a.field) - CANONICAL_FIELDS.indexOf(b.field),
  );
  const mapping: ColumnMapping = {};
  const scores: MappingSuggestion["scores"] = {};
  const usedCols = new Set<number>();
  for (const c of candidates) {
    if (mapping[c.field] !== undefined || usedCols.has(c.col)) continue;
    mapping[c.field] = headers[c.col];
    scores[c.field] = Math.round(c.score * 100) / 100;
    usedCols.add(c.col);
  }
  return { mapping, scores, unmappedColumns: headers.filter((_, i) => !usedCols.has(i)) };
}

export interface MappingValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate a mapping against the file headers and the zone assignment pattern. */
export function validateMapping(
  mapping: ColumnMapping,
  headers: string[],
  fixedZoneId: string | null,
): MappingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const headerSet = new Set(headers);
  for (const [field, col] of Object.entries(mapping)) {
    if (col && !headerSet.has(col))
      errors.push(`Column "${col}" mapped to ${field} is not present in the file`);
  }
  const cols = Object.values(mapping).filter(Boolean);
  if (new Set(cols).size !== cols.length) errors.push("The same column is mapped to more than one field");
  if (!mapping.epc) errors.push("An EPC column is required");
  if (!mapping.zone && !fixedZoneId)
    errors.push("Map a zone column (combined file) or assign the whole file to a zone (separate zone file)");
  if (mapping.zone && fixedZoneId)
    warnings.push(
      "The file is assigned to a zone and also has a zone column; rows whose zone differs will be flagged",
    );
  if (!mapping.rssi) warnings.push("No RSSI column: signal-strength evidence will be unavailable");
  if (!mapping.timestamp)
    warnings.push("No timestamp column: temporal evidence and session timing will be unavailable");
  if (!mapping.readCount) warnings.push("No read count column: each row is treated as at least one read");
  return { ok: errors.length === 0, errors, warnings };
}

const TYPE_ALIASES: Record<ZoneType, string[]> = {
  SALES_FLOOR: ["salesfloor", "sf", "floor", "sales", "shopfloor", "store floor", "frontofhouse", "foh"],
  BACK_ROOM: [
    "backroom",
    "br",
    "stockroom",
    "stock room",
    "back",
    "storeroom",
    "backofhouse",
    "boh",
    "warehouse",
  ],
  RECEIVING: ["receiving", "rcv", "inbound", "goodsin"],
  DISPATCH: ["dispatch", "shipping", "outbound", "goodsout"],
  FITTING_ROOM: ["fittingroom", "fr", "changingroom", "dressingroom"],
  OTHER: [],
};

function compact(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve a raw zone value from a file to a configured zone. Explicit
 * user-confirmed mappings win; then code, name and aliases; then the default
 * synonyms of the zone type when exactly one zone of that type exists.
 */
export function resolveZoneValue(
  raw: string,
  zones: ZoneRef[],
  explicit: Record<string, string>,
): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (explicit[v]) return explicit[v];
  const c = compact(v);
  for (const z of zones) {
    if (
      compact(z.code) === c ||
      compact(z.name) === c ||
      compact(z.id) === c ||
      z.aliases.some((a) => compact(a) === c)
    )
      return z.id;
  }
  for (const [type, aliases] of Object.entries(TYPE_ALIASES)) {
    if (aliases.map(compact).includes(c)) {
      const ofType = zones.filter((z) => z.type === type);
      if (ofType.length === 1) return ofType[0].id;
    }
  }
  return null;
}
