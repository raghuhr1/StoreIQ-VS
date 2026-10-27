/**
 * CSV output helpers (RFC 4180, CRLF line endings, UTF-8 without BOM).
 *
 * Spreadsheet formula injection: any *text* cell starting with = + - @ tab or
 * carriage return is prefixed with a single quote so spreadsheet software
 * treats it as text. Numeric cells are emitted as numbers and never prefixed,
 * so negative RSSI values stay numeric.
 */
export type Cell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function sanitizeText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function escapeCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "number") s = Number.isFinite(value) ? String(value) : "";
  else if (typeof value === "boolean") s = value ? "true" : "false";
  else s = sanitizeText(value);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: Cell[][]): string {
  const lines = [header.map(escapeCell).join(",")];
  for (const r of rows) lines.push(r.map(escapeCell).join(","));
  return lines.join("\r\n") + "\r\n";
}
