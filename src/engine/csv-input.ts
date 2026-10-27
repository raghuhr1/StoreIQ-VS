import { parse } from "csv-parse";
import { Readable } from "node:stream";

export type CsvDelimiter = "," | ";" | "\t" | "|";

export interface CsvSniff {
  encoding: "UTF-8";
  hasBom: boolean;
  delimiter: CsvDelimiter;
  lineEnding: "CRLF" | "LF" | "CR" | "MIXED" | "NONE";
}

export type SniffResult = { ok: true; sniff: CsvSniff } | { ok: false; code: string; message: string };

const DELIMS: CsvDelimiter[] = [",", ";", "\t", "|"];

/** Count delimiter candidates in the header line, ignoring quoted sections. */
function countOutsideQuotes(line: string, ch: string) {
  let n = 0;
  let inQ = false;
  for (const c of line) {
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === ch) n++;
  }
  return n;
}

/**
 * Inspect the first bytes of an upload. Rejects binary content, spreadsheets
 * and non-UTF-8 text; detects BOM, delimiter and line endings.
 */
export function sniffCsv(head: Uint8Array): SniffResult {
  if (head.length === 0) return { ok: false, code: "EMPTY_FILE", message: "The file is empty" };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)
    return {
      ok: false,
      code: "UNSUPPORTED_XLSX",
      message: "Spreadsheet (XLSX/ZIP) files are not supported; export the scan as CSV",
    };
  if (head.includes(0))
    return {
      ok: false,
      code: "BINARY_FILE",
      message: "The file contains binary data and is not a CSV text file",
    };
  const hasBom = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  let text: string;
  try {
    // stream:true tolerates a multi-byte character cut at the end of the sample.
    text = new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    return {
      ok: false,
      code: "INVALID_ENCODING",
      message: "The file is not valid UTF-8 text; save the export as UTF-8 CSV",
    };
  }
  if (hasBom) text = text.slice(1);
  const firstLine = text.split(/\r\n|\n|\r/)[0] ?? "";
  if (!firstLine.trim())
    return { ok: false, code: "MISSING_HEADER", message: "The first line (header row) is empty" };
  let delimiter: CsvDelimiter = ",";
  let best = 0;
  for (const d of DELIMS) {
    const n = countOutsideQuotes(firstLine, d);
    if (n > best) {
      best = n;
      delimiter = d;
    }
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const kinds = [crlf, lf, cr].filter((n) => n > 0).length;
  const lineEnding = kinds === 0 ? "NONE" : kinds > 1 ? "MIXED" : crlf ? "CRLF" : lf ? "LF" : "CR";
  return { ok: true, sniff: { encoding: "UTF-8", hasBom, delimiter, lineEnding } };
}

export type CsvItem =
  | { kind: "header"; headers: string[]; warnings: string[] }
  | { kind: "record"; record: string[]; rowNumber: number }
  | { kind: "malformed"; rowNumber: number; message: string };

/** Make header names unique and non-empty. */
export function normalizeHeaders(raw: string[]): { headers: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const seen = new Map<string, number>();
  const headers = raw.map((h, i) => {
    let name = h.replace(/^﻿/, "").trim();
    if (!name) {
      name = `column_${i + 1}`;
      warnings.push(`Column ${i + 1} has no header; named "${name}"`);
    }
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count > 0) {
      const renamed = `${name}_${count + 1}`;
      warnings.push(`Duplicate header "${name}" renamed to "${renamed}"`);
      return renamed;
    }
    return name;
  });
  return { headers, warnings };
}

/**
 * Stream CSV records from bytes. Never buffers the whole file. Rows with
 * syntax errors (e.g. unbalanced quotes) are reported as "malformed" and
 * parsing continues. Row numbers are physical line numbers (header = 1).
 */
export async function* readCsv(
  source: AsyncIterable<Uint8Array | string> | Readable,
  delimiter: CsvDelimiter,
  opts: { maxRecords?: number } = {},
): AsyncGenerator<CsvItem> {
  // The parser runs ahead of this consumer, so skip notifications are queued
  // with their physical line and released in order relative to records.
  const skipped: { line: number; message: string }[] = [];
  const parser = parse({
    delimiter,
    bom: true,
    info: true,
    relax_column_count: true,
    skip_empty_lines: true,
    skip_records_with_error: true,
    max_record_size: 1_000_000,
    on_skip: (err) => {
      const line = (err as { lines?: number } | undefined)?.lines ?? Number.MAX_SAFE_INTEGER;
      skipped.push({ line, message: err?.message?.slice(0, 200) ?? "Malformed CSV row" });
      return undefined;
    },
  });
  const input = source instanceof Readable ? source : Readable.from(source);
  input.on("error", (e) => parser.destroy(e));
  input.pipe(parser);

  // Row numbers are record numbers (header = 1). They equal line numbers when
  // no field contains an embedded line break.
  let rowNumber = 0;
  let records = 0;
  const release = function* (upToLine: number): Generator<CsvItem> {
    while (skipped.length && skipped[0].line <= upToLine)
      yield { kind: "malformed", rowNumber: ++rowNumber, message: skipped.shift()!.message };
  };
  try {
    for await (const item of parser as AsyncIterable<{ record: string[]; info: { lines: number } }>) {
      if (rowNumber === 0) {
        rowNumber = 1;
        yield { kind: "header", ...normalizeHeaders(item.record) };
        continue;
      }
      yield* release(item.info.lines - 1);
      yield { kind: "record", record: item.record, rowNumber: ++rowNumber };
      if (opts.maxRecords !== undefined && ++records >= opts.maxRecords) return;
    }
    if (rowNumber === 0 && skipped.length) rowNumber = 1; // header itself was unreadable
    yield* release(Number.MAX_SAFE_INTEGER);
  } finally {
    input.unpipe(parser);
    parser.destroy();
    if ("destroy" in input) input.destroy();
  }
}
