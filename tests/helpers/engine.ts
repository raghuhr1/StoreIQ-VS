import {
  EngineRun,
  readCsv,
  resolveProfile,
  runCsv,
  type ColumnMapping,
  type FileContext,
  type ProcessingProfileConfig,
  type ZoneRef,
} from "@/engine";

export const SF: ZoneRef = {
  id: "z-sf",
  code: "SALES_FLOOR",
  name: "Sales Floor",
  type: "SALES_FLOOR",
  aliases: ["SF"],
  sortOrder: 0,
};
export const BR: ZoneRef = {
  id: "z-br",
  code: "BACK_ROOM",
  name: "Back Room",
  type: "BACK_ROOM",
  aliases: ["BR"],
  sortOrder: 1,
};
export const ZONES = [SF, BR];

export function fileCtx(over: Partial<FileContext> & { mapping: ColumnMapping }): FileContext {
  return {
    uploadId: "u1",
    fixedZoneId: null,
    sessionLabel: "S",
    zoneValueMap: {},
    dateFormat: "AUTO",
    timeZone: "UTC",
    ...over,
  };
}

export async function* chunks(text: string, size = 7) {
  const buf = Buffer.from(text, "utf8");
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

export interface FileSpec {
  csv: string;
  ctx: FileContext;
}

export async function runFiles(
  files: FileSpec[],
  profileOverride: unknown = {},
  extra: { anchors?: { epc: string; zoneId: string }[]; profile?: ProcessingProfileConfig } = {},
) {
  const profile = extra.profile ?? resolveProfile(profileOverride);
  return runCsv(
    { profile, zones: ZONES, relationships: [], anchors: extra.anchors ?? [] },
    files.map((f) => ({ file: f.ctx, delimiter: ",", source: chunks(f.csv) })),
  );
}

/** Build a CSV from a header and rows. */
export function csv(header: string[], rows: (string | number)[][]) {
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
}

export { EngineRun, readCsv };
