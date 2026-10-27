import type { ProcessingProfileConfig } from "./profile";

export type EpcRules = ProcessingProfileConfig["epc"];

export type EpcIssue =
  "MISSING" | "NON_HEX" | "TOO_SHORT" | "TOO_LONG" | "LENGTH_NOT_WORD_ALIGNED" | "INVALID_CHARACTERS";

export interface NormalizedEpc {
  /** Normalized identifier ("" when missing). */
  epc: string;
  valid: boolean;
  issue: EpcIssue | null;
}

const HEX = /^[0-9A-F]+$/;
// Printable ASCII without spaces or control characters.
const PRINTABLE = /^[\x21-\x7E]+$/;

/**
 * Normalize an EPC for comparison while keeping it traceable to the original.
 *
 * Only presentation differences are removed (surrounding whitespace, optional
 * 0x prefix, separators, letter case for hex). The value is never truncated,
 * padded, or stripped of leading zeros, so two different EPCs can never be
 * merged by normalization.
 */
export function normalizeEpc(raw: string, rules: EpcRules): NormalizedEpc {
  let s = raw.trim();
  if (rules.stripHexPrefix && rules.format === "HEX" && /^0x/i.test(s)) s = s.slice(2);
  if (rules.removeSeparators) s = s.replace(/[\s\-:]/g, "");
  if (s.length === 0) return { epc: "", valid: false, issue: "MISSING" };

  if (rules.format === "HEX") {
    s = s.toUpperCase();
    if (!HEX.test(s)) return { epc: s, valid: false, issue: "NON_HEX" };
  } else if (!PRINTABLE.test(s)) {
    return { epc: s, valid: false, issue: "INVALID_CHARACTERS" };
  }
  if (s.length < rules.minLength) return { epc: s, valid: false, issue: "TOO_SHORT" };
  if (s.length > rules.maxLength) return { epc: s, valid: false, issue: "TOO_LONG" };
  if (rules.format === "HEX" && rules.lengthMultipleOf > 1 && s.length % rules.lengthMultipleOf !== 0)
    return { epc: s, valid: false, issue: "LENGTH_NOT_WORD_ALIGNED" };
  return { epc: s, valid: true, issue: null };
}

export const EPC_ISSUE_TEXT: Record<EpcIssue, string> = {
  MISSING: "EPC is empty",
  NON_HEX: "EPC contains non-hexadecimal characters",
  TOO_SHORT: "EPC is shorter than the configured minimum length",
  TOO_LONG: "EPC is longer than the configured maximum length",
  LENGTH_NOT_WORD_ALIGNED: "EPC hex length is not a whole number of 16-bit words",
  INVALID_CHARACTERS: "EPC contains spaces or control characters",
};
