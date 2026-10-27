import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  formatTimestamp,
  normalizeEpc,
  parseTimestamp,
  resolveProfile,
  safeResolveProfile,
} from "@/engine";

const rules = DEFAULT_PROFILE.epc;

describe("EPC normalization", () => {
  it("trims, strips 0x and separators, upper-cases hex", () => {
    expect(normalizeEpc("  0xe280-1160:6000 0204 1234 5678 ", rules)).toEqual({
      epc: "E28011606000020412345678",
      valid: true,
      issue: null,
    });
  });

  it("never strips leading zeros or changes length", () => {
    const a = normalizeEpc("000000000000000000000001", rules);
    const b = normalizeEpc("00000000000000000001", rules);
    expect(a.epc).toBe("000000000000000000000001");
    expect(b.epc).toBe("00000000000000000001");
    expect(a.epc).not.toBe(b.epc);
  });

  it("flags non-hex, short, long and misaligned values", () => {
    expect(normalizeEpc("E2801160XYZ0", rules).issue).toBe("NON_HEX");
    expect(normalizeEpc("E280", rules).issue).toBe("TOO_SHORT");
    expect(normalizeEpc("E".repeat(132), rules).issue).toBe("TOO_LONG");
    expect(normalizeEpc("E28011606", rules).issue).toBe("LENGTH_NOT_WORD_ALIGNED");
    expect(normalizeEpc("   ", rules).issue).toBe("MISSING");
  });

  it("ANY format preserves case and rejects control characters", () => {
    const any = { ...rules, format: "ANY" as const, lengthMultipleOf: 1 };
    expect(
      normalizeEpc("urn:epc:id:sgtin:0614141.812345.6789", { ...any, removeSeparators: false }).epc,
    ).toBe("urn:epc:id:sgtin:0614141.812345.6789");
    expect(normalizeEpc("abc\u0007defgh", any).valid).toBe(false);
  });
});

describe("timestamp parsing", () => {
  it("parses ISO with offset and Z", () => {
    expect(parseTimestamp("2026-10-01T10:00:00Z", "AUTO", "UTC")).toEqual({
      ok: true,
      value: Date.UTC(2026, 9, 1, 10),
    });
    expect(parseTimestamp("2026-10-01T10:00:00+05:30", "AUTO", "UTC")).toEqual({
      ok: true,
      value: Date.UTC(2026, 9, 1, 4, 30),
    });
  });

  it("interprets offset-less values in the store time zone (DST-aware)", () => {
    // New York is UTC-4 in October (EDT) and UTC-5 in January (EST).
    expect(parseTimestamp("2026-10-01 10:00:00", "AUTO", "America/New_York")).toEqual({
      ok: true,
      value: Date.UTC(2026, 9, 1, 14),
    });
    expect(parseTimestamp("2026-01-15 10:00:00", "AUTO", "America/New_York")).toEqual({
      ok: true,
      value: Date.UTC(2026, 0, 15, 15),
    });
  });

  it("parses epoch seconds and milliseconds", () => {
    expect(parseTimestamp("1790000000", "AUTO", "UTC")).toEqual({ ok: true, value: 1790000000000 });
    expect(parseTimestamp("1790000000123", "AUTO", "UTC")).toEqual({ ok: true, value: 1790000000123 });
  });

  it("refuses to guess ambiguous slash dates but honours an explicit format", () => {
    const r = parseTimestamp("03/04/2026 10:00", "AUTO", "UTC");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("AMBIGUOUS_TIMESTAMP");
    expect(parseTimestamp("03/04/2026 10:00", "DMY", "UTC")).toEqual({
      ok: true,
      value: Date.UTC(2026, 3, 3, 10),
    });
    expect(parseTimestamp("13/04/2026 1:05 PM", "AUTO", "UTC")).toEqual({
      ok: true,
      value: Date.UTC(2026, 3, 13, 13, 5),
    });
  });

  it("rejects invalid dates", () => {
    expect(parseTimestamp("2026-02-30 10:00", "AUTO", "UTC").ok).toBe(false);
    expect(parseTimestamp("yesterday", "AUTO", "UTC").ok).toBe(false);
    expect(parseTimestamp("1890-01-01", "AUTO", "UTC").ok).toBe(false);
  });

  it("formats as ISO UTC or empty", () => {
    expect(formatTimestamp(Date.UTC(2026, 0, 1))).toBe("2026-01-01T00:00:00.000Z");
    expect(formatTimestamp(null)).toBe("");
  });
});

describe("processing profile", () => {
  it("merges partial overrides over defaults", () => {
    const p = resolveProfile({ bands: { high: 90 } });
    expect(p.bands).toEqual({ high: 90, medium: 60 });
    expect(p.weights).toEqual(DEFAULT_PROFILE.weights);
  });

  it("rejects unsafe or inconsistent combinations", () => {
    expect(safeResolveProfile({ bands: { high: 60, medium: 70 } }).success).toBe(false);
    expect(safeResolveProfile({ bands: { high: 65, medium: 50 } }).success).toBe(false);
    expect(safeResolveProfile({ weights: { exclusivity: 0 } }).success).toBe(false);
    expect(safeResolveProfile({ rules: { rejectBelowCalibratedThreshold: true } }).success).toBe(false);
    expect(safeResolveProfile({ epc: { minLength: 50, maxLength: 10 } }).success).toBe(false);
    expect(
      safeResolveProfile({
        rules: { rejectBelowCalibratedThreshold: true },
        zoneCalibration: { SALES_FLOOR: { weakRssiThreshold: -70 } },
      }).success,
    ).toBe(true);
  });
});
