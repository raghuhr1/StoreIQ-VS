import { EPC_ISSUE_TEXT, normalizeEpc } from "./epc";
import { resolveZoneValue } from "./mapping";
import type { ProcessingProfileConfig } from "./profile";
import { parseTimestamp } from "./timestamps";
import type { CanonicalField, FileContext, Observation, RowIssue, ZoneRef } from "./types";

export interface MappedRow {
  observation: Observation | null;
  issues: RowIssue[];
}

function parseNumber(v: string): number | null {
  let s = v.trim();
  if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  if (!/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseBool(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return null;
}

const MAX_TEXT = 128;

/**
 * Build a function that validates and maps one CSV record (array of cells) to
 * an observation. `rowNumber` is the 1-based record number including the
 * header row (the first data row is 2).
 */
export function createRowMapper(
  file: FileContext,
  headers: string[],
  zones: ZoneRef[],
  profile: ProcessingProfileConfig,
) {
  const index = new Map(headers.map((h, i) => [h, i]));
  const col = (field: CanonicalField) => {
    const name = file.mapping[field];
    return name === undefined ? -1 : (index.get(name) ?? -1);
  };
  const cols = Object.fromEntries(
    (
      [
        "epc",
        "zone",
        "session",
        "timestamp",
        "rssi",
        "readCount",
        "phase",
        "readerId",
        "antennaId",
        "channel",
        "txPower",
        "anchorFlag",
      ] as const
    ).map((f) => [f, col(f)]),
  ) as Record<CanonicalField, number>;
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const zoneCache = new Map<string, string | null>();
  const resolveZone = (raw: string) => {
    if (!zoneCache.has(raw)) zoneCache.set(raw, resolveZoneValue(raw, zones, file.zoneValueMap));
    return zoneCache.get(raw)!;
  };

  return function mapRow(record: string[], rowNumber: number): MappedRow {
    const issues: RowIssue[] = [];
    const issue = (code: string, message: string, severity: "error" | "warning", field?: CanonicalField) =>
      issues.push({ uploadId: file.uploadId, rowNumber, code, message, field, severity });
    const cell = (f: CanonicalField) => (cols[f] >= 0 ? (record[cols[f]] ?? "").trim() : "");

    if (record.length < headers.length || record.slice(headers.length).some((c) => c.trim() !== "")) {
      issue("MALFORMED_ROW", `Row has ${record.length} columns; header has ${headers.length}`, "error");
      return { observation: null, issues };
    }

    // EPC (required)
    const epcRaw = cell("epc");
    if (!epcRaw) {
      issue("MISSING_EPC", "EPC value is empty", "error", "epc");
      return { observation: null, issues };
    }
    const n = normalizeEpc(epcRaw, profile.epc);
    if (!n.valid) {
      const msg = `${EPC_ISSUE_TEXT[n.issue!]} ("${epcRaw.slice(0, 40)}")`;
      if (profile.epc.malformedPolicy === "REJECT") {
        issue("MALFORMED_EPC", msg, "error", "epc");
        return { observation: null, issues };
      }
      issue("MALFORMED_EPC", `${msg}; kept for review`, "warning", "epc");
    }

    // Zone (required: fixed file zone or zone column)
    let zoneId: string | null = file.fixedZoneId;
    let labelConflict = false;
    const zoneRaw = cell("zone");
    if (file.fixedZoneId) {
      if (zoneRaw) {
        const resolved = resolveZone(zoneRaw);
        if (resolved && resolved !== file.fixedZoneId) {
          labelConflict = true;
          issue(
            "ZONE_LABEL_CONFLICT",
            `Row zone "${zoneRaw}" differs from the file's assigned zone ${zoneById.get(file.fixedZoneId)?.code ?? ""}`,
            "warning",
            "zone",
          );
        } else if (!resolved) {
          issue(
            "UNKNOWN_ZONE_LABEL",
            `Row zone "${zoneRaw}" is not a configured zone; file zone used`,
            "warning",
            "zone",
          );
        }
      }
    } else {
      if (!zoneRaw) {
        issue("MISSING_ZONE", "Zone value is empty", "error", "zone");
        return { observation: null, issues };
      }
      zoneId = resolveZone(zoneRaw);
      if (!zoneId) {
        issue(
          "UNKNOWN_ZONE",
          `Zone "${zoneRaw.slice(0, 40)}" does not match a configured zone; map it in the zone mapping step`,
          "error",
          "zone",
        );
        return { observation: null, issues };
      }
    }

    // Session
    let sessionExternalId = cell("session");
    if (!sessionExternalId) {
      sessionExternalId = file.fixedZoneId
        ? file.sessionLabel
        : `${file.sessionLabel}:${zoneById.get(zoneId!)?.code ?? zoneId}`;
    }
    sessionExternalId = sessionExternalId.slice(0, MAX_TEXT);

    // Optional fields: invalid values become null with a warning (never fabricated).
    let timestamp: number | null = null;
    const tsRaw = cell("timestamp");
    if (tsRaw) {
      const t = parseTimestamp(tsRaw, file.dateFormat, file.timeZone);
      if (t.ok) timestamp = t.value;
      else issue(t.code, t.message, "warning", "timestamp");
    }

    let rssi: number | null = null;
    const rssiRaw = cell("rssi");
    if (rssiRaw) {
      const v = parseNumber(rssiRaw);
      if (v === null)
        issue("INVALID_RSSI", `RSSI "${rssiRaw.slice(0, 20)}" is not a number`, "warning", "rssi");
      else if (v < profile.rssi.validMin || v > profile.rssi.validMax)
        issue(
          "RSSI_OUT_OF_RANGE",
          `RSSI ${v} is outside ${profile.rssi.validMin}..${profile.rssi.validMax} dBm`,
          "warning",
          "rssi",
        );
      else rssi = v;
    }

    let readCount: number | null = null;
    const rcRaw = cell("readCount");
    if (rcRaw) {
      const v = parseNumber(rcRaw);
      if (v === null || !Number.isInteger(v) || v < 1)
        issue(
          "INVALID_READ_COUNT",
          `Read count "${rcRaw.slice(0, 20)}" is not a positive integer; treated as unknown`,
          "warning",
          "readCount",
        );
      else readCount = v;
    }

    const optNum = (f: CanonicalField, code: string) => {
      const raw = cell(f);
      if (!raw) return null;
      const v = parseNumber(raw);
      if (v === null) issue(code, `${f} "${raw.slice(0, 20)}" is not a number`, "warning", f);
      return v;
    };
    const phase = optNum("phase", "INVALID_PHASE");
    const channel = optNum("channel", "INVALID_CHANNEL");
    const txPower = optNum("txPower", "INVALID_TX_POWER");

    let anchorFlag: boolean | null = null;
    const afRaw = cell("anchorFlag");
    if (afRaw) {
      anchorFlag = parseBool(afRaw);
      if (anchorFlag === null)
        issue(
          "INVALID_ANCHOR_FLAG",
          `Anchor indicator "${afRaw.slice(0, 20)}" is not yes/no`,
          "warning",
          "anchorFlag",
        );
    }

    return {
      issues,
      observation: {
        uploadId: file.uploadId,
        rowNumber,
        epcRaw: epcRaw.slice(0, 256),
        epc: n.epc.slice(0, 256),
        epcValid: n.valid,
        epcIssue: n.issue,
        zoneId: zoneId!,
        sessionKey: `${file.uploadId}::${sessionExternalId}`,
        sessionExternalId,
        timestamp,
        rssi,
        readCount,
        phase,
        readerId: cell("readerId").slice(0, MAX_TEXT) || null,
        antennaId: cell("antennaId").slice(0, MAX_TEXT) || null,
        channel,
        txPower,
        anchorFlag,
        labelConflict,
      },
    };
  };
}
