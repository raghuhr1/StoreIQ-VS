import type { DateFormat } from "./types";

export type TimestampResult =
  | { ok: true; value: number }
  | { ok: false; code: "INVALID_TIMESTAMP" | "AMBIGUOUS_TIMESTAMP"; message: string };

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `timeZone` from UTC at instant `utcMs`. */
function tzOffset(utcMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` to a UTC instant (handles DST). */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
  timeZone: string,
) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (timeZone === "UTC") return guess;
  let result = guess - tzOffset(guess, timeZone);
  const second = tzOffset(result, timeZone);
  result = guess - second;
  return result;
}

function validParts(y: number, mo: number, d: number, h: number, mi: number, s: number) {
  if (y < MIN_YEAR || y > MAX_YEAR || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 60) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const SLASH_RE =
  /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(AM|PM)?)?$/i;

const invalid = (v: string): TimestampResult => ({
  ok: false,
  code: "INVALID_TIMESTAMP",
  message: `Unrecognized or out-of-range timestamp "${v.slice(0, 40)}"`,
});

/**
 * Parse a timestamp from a scan export. Values without an explicit offset are
 * interpreted in the store's time zone. Slash dates are only accepted when
 * unambiguous unless the mapping fixes MDY or DMY.
 */
export function parseTimestamp(value: string, format: DateFormat, timeZone: string): TimestampResult {
  const v = value.trim();
  if (/^\d{9,13}(\.\d+)?$/.test(v) && format !== "ISO" && format !== "MDY" && format !== "DMY") {
    const n = Number(v);
    let ms: number;
    if (format === "EPOCH_S") ms = n * 1000;
    else if (format === "EPOCH_MS") ms = n;
    else ms = v.split(".")[0].length >= 12 ? n : n * 1000;
    const y = new Date(ms).getUTCFullYear();
    return y >= MIN_YEAR && y <= MAX_YEAR ? { ok: true, value: Math.round(ms) } : invalid(v);
  }
  if (format === "EPOCH_S" || format === "EPOCH_MS") return invalid(v);

  const iso = ISO_RE.exec(v);
  if (iso && (format === "AUTO" || format === "ISO")) {
    const [, Y, M, D, h = "0", mi = "0", s = "0", frac = "0", off] = iso;
    const parts = [Number(Y), Number(M), Number(D), Number(h), Number(mi), Number(s)] as const;
    if (!validParts(...parts)) return invalid(v);
    const ms = Number(frac.padEnd(3, "0").slice(0, 3));
    if (off) {
      let base = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], ms);
      if (off.toUpperCase() !== "Z") {
        const sign = off[0] === "-" ? -1 : 1;
        const digits = off.slice(1).replace(":", "");
        base -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
      }
      return { ok: true, value: base };
    }
    return { ok: true, value: zonedToUtc(...parts, ms, timeZone) };
  }

  const sl = SLASH_RE.exec(v);
  if (sl && format !== "ISO") {
    const [, a, b, Y, hRaw = "0", mi = "0", s = "0", frac = "0", ampm] = sl;
    const first = Number(a);
    const second = Number(b);
    let order: "MDY" | "DMY";
    if (format === "MDY" || format === "DMY") order = format;
    else if (first > 12 && second <= 12) order = "DMY";
    else if (second > 12 && first <= 12) order = "MDY";
    else if (first === second) order = "MDY";
    else
      return {
        ok: false,
        code: "AMBIGUOUS_TIMESTAMP",
        message: `Date "${v.slice(0, 40)}" could be month/day or day/month; choose a date format in the column mapping`,
      };
    let h = Number(hRaw);
    if (ampm) {
      if (h < 1 || h > 12) return invalid(v);
      h = (h % 12) + (ampm.toUpperCase() === "PM" ? 12 : 0);
    }
    const mo = order === "MDY" ? first : second;
    const d = order === "MDY" ? second : first;
    if (!validParts(Number(Y), mo, d, h, Number(mi), Number(s))) return invalid(v);
    const ms = Number(frac.padEnd(3, "0").slice(0, 3));
    return { ok: true, value: zonedToUtc(Number(Y), mo, d, h, Number(mi), Number(s), ms, timeZone) };
  }
  return invalid(v);
}

/** Canonical export format: ISO 8601 UTC with milliseconds. */
export function formatTimestamp(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString();
}
