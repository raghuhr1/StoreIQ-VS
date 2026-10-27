import { describe, expect, it } from "vitest";
import {
  escapeCell,
  readCsv,
  resolveZoneValue,
  sniffCsv,
  suggestMapping,
  toCsv,
  validateMapping,
} from "@/engine";
import { chunks, ZONES } from "../helpers/engine";

async function collect(text: string | Buffer, delimiter: "," | ";" = ",") {
  const src =
    typeof text === "string"
      ? chunks(text, 5)
      : (async function* () {
          yield text;
        })();
  const out = [];
  for await (const i of readCsv(src, delimiter)) out.push(i);
  return out;
}

describe("column mapping suggestions", () => {
  it("maps common aliases and leaves unknown columns unmapped", () => {
    const s = suggestMapping(
      ["Tag ID", "Location", "Scan Session", "Date Time", "PeakRSSI", "Reads", "Antenna", "Comments"],
      [["E28011606000020412345678", "SF", "A1", "2026-10-01 10:00:00", "-52.5", "3", "1", "hello"]],
    );
    expect(s.mapping).toEqual({
      epc: "Tag ID",
      zone: "Location",
      session: "Scan Session",
      timestamp: "Date Time",
      rssi: "PeakRSSI",
      readCount: "Reads",
      antennaId: "Antenna",
    });
    expect(s.unmappedColumns).toEqual(["Comments"]);
  });

  it("detects an EPC column from values when the header is unknown", () => {
    const s = suggestMapping(
      ["Col1", "Col2"],
      [
        ["E28011606000020412345678", "x"],
        ["E28011606000020412345679", "y"],
      ],
    );
    expect(s.mapping.epc).toBe("Col1");
  });

  it("validates required fields and column existence", () => {
    expect(validateMapping({ zone: "Zone" }, ["Zone"], null).errors).toContain("An EPC column is required");
    expect(validateMapping({ epc: "EPC" }, ["EPC"], null).ok).toBe(false);
    expect(validateMapping({ epc: "EPC" }, ["EPC"], "z-sf").ok).toBe(true);
    expect(validateMapping({ epc: "Missing" }, ["EPC"], "z-sf").ok).toBe(false);
    expect(validateMapping({ epc: "EPC", zone: "EPC" }, ["EPC"], null).ok).toBe(false);
  });

  it("resolves zone values by code, name, alias, type synonym and explicit map", () => {
    expect(resolveZoneValue("Sales Floor", ZONES, {})).toBe("z-sf");
    expect(resolveZoneValue("back_room", ZONES, {})).toBe("z-br");
    expect(resolveZoneValue("BR", ZONES, {})).toBe("z-br");
    expect(resolveZoneValue("Stockroom", ZONES, {})).toBe("z-br");
    expect(resolveZoneValue("Z9", ZONES, { Z9: "z-sf" })).toBe("z-sf");
    expect(resolveZoneValue("Mezzanine", ZONES, {})).toBeNull();
  });
});

describe("CSV input", () => {
  it("sniffs BOM, delimiter and line endings; rejects binary/xlsx/non-UTF-8", () => {
    const bom = sniffCsv(Buffer.from("﻿EPC;Zone\r\nA;B\r\n"));
    expect(bom).toEqual({
      ok: true,
      sniff: { encoding: "UTF-8", hasBom: true, delimiter: ";", lineEnding: "CRLF" },
    });
    expect(
      sniffCsv(Buffer.from("EPC,Zone\nA,B\n")).ok &&
        (sniffCsv(Buffer.from("EPC,Zone\nA,B\n")) as { sniff: { lineEnding: string } }).sniff.lineEnding,
    ).toBe("LF");
    expect(sniffCsv(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_XLSX",
    });
    expect(sniffCsv(Buffer.from([0x45, 0x00, 0x41]))).toMatchObject({ ok: false, code: "BINARY_FILE" });
    expect(sniffCsv(Buffer.from([0x45, 0x50, 0xc3, 0x28, 0x0a]))).toMatchObject({
      ok: false,
      code: "INVALID_ENCODING",
    });
    expect(sniffCsv(Buffer.alloc(0))).toMatchObject({ ok: false, code: "EMPTY_FILE" });
  });

  it("parses quoted fields with commas, quotes and newlines; Windows endings and BOM", async () => {
    const items = await collect('﻿EPC,Note\r\nAAAA0000,"a, ""quoted""\r\nvalue"\r\nBBBB0000,plain\r\n');
    expect(items[0]).toEqual({ kind: "header", headers: ["EPC", "Note"], warnings: [] });
    expect(items[1]).toMatchObject({ kind: "record", record: ["AAAA0000", 'a, "quoted"\r\nvalue'] });
    expect(items[2]).toMatchObject({ kind: "record", record: ["BBBB0000", "plain"], rowNumber: 3 });
  });

  it("reports malformed rows and continues", async () => {
    const items = await collect('EPC,Zone\nAAAA0000,SF\n"BROKEN,SF\nCCCC0000,BR\n');
    const kinds = items.map((i) => i.kind);
    expect(kinds[0]).toBe("header");
    expect(kinds).toContain("malformed");
  });

  it("names empty and duplicate headers", async () => {
    const items = await collect("EPC,,EPC\n1,2,3\n");
    expect(items[0]).toMatchObject({ headers: ["EPC", "column_2", "EPC_2"] });
  });
});

describe("CSV output", () => {
  it("escapes per RFC 4180", () => {
    expect(escapeCell('a,"b"')).toBe('"a,""b"""');
    expect(escapeCell("line\nbreak")).toBe('"line\nbreak"');
    expect(escapeCell(null)).toBe("");
    expect(escapeCell(true)).toBe("true");
  });

  it("neutralises spreadsheet formulas in text but keeps negative numbers numeric", () => {
    for (const v of ['=HYPERLINK("x")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd"])
      expect(escapeCell(v).replace(/^"/, "")).toMatch(/^'/);
    expect(escapeCell(-52.5)).toBe("-52.5");
    expect(toCsv(["a", "b"], [["=1", -3]])).toBe("a,b\r\n'=1,-3\r\n");
  });
});
