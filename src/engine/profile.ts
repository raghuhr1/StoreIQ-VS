import { z } from "zod";

/**
 * Version of the rule implementation. Bump on any change that can alter a
 * classification for the same input + profile, so results stay reproducible.
 */
export const RULES_VERSION = "svs-rules/1.0.0";
export const EXPORT_SCHEMA_VERSION = "svs-export/1.0";

const unit = z.number().min(0).max(1);

export const processingProfileSchema = z
  .object({
    epc: z.object({
      /** "HEX": EPC memory as hexadecimal. "ANY": printable identifier, case preserved. */
      format: z.enum(["HEX", "ANY"]),
      minLength: z.int().min(1).max(256),
      maxLength: z.int().min(1).max(256),
      /** Hex length must be a multiple of this (EPC memory is 16-bit words => 4). 1 disables. */
      lengthMultipleOf: z.int().min(1).max(32),
      /** Remove spaces, hyphens and colons inside the identifier. */
      removeSeparators: z.boolean(),
      /** Strip a leading 0x/0X. */
      stripHexPrefix: z.boolean(),
      /** "FLAG": keep the EPC and send it to review. "REJECT": exclude the row. */
      malformedPolicy: z.enum(["FLAG", "REJECT"]),
    }),
    duplicates: z.object({
      /**
       * AUTO: collapse identical rows when the export carries read counts or
       * timestamps (an identical row is then the same record twice); otherwise
       * count each identical row as a separate read.
       */
      policy: z.enum(["AUTO", "COLLAPSE", "COUNT_AS_READS"]),
    }),
    invalidRows: z.object({
      /** Fail the job if more than this share of rows is invalid (likely a wrong mapping). */
      maxInvalidRowRatio: unit,
    }),
    timing: z.object({
      observationWindowSeconds: z.number().min(1).max(3600),
      /** Sessions in different zones further apart than this are not compared as one inventory cycle. */
      maxSessionGapHours: z
        .number()
        .min(0.25)
        .max(24 * 14),
    }),
    rssi: z.object({
      validMin: z.number().min(-200).max(0),
      validMax: z.number().min(-100).max(50),
      /** RSSI margin (dB) between zones that yields full support. */
      marginForFullSupportDb: z.number().min(1).max(60),
      /** Only compare RSSI across zones when the same reader produced both (or reader is unknown). */
      requireSameReader: z.boolean(),
    }),
    evidence: z.object({
      minReadsForFullSupport: z.int().min(1).max(10_000),
      minWindowsForFullSupport: z.int().min(1).max(1000),
      /** Count dominance (0.5-1) required to accept a multi-zone EPC without comparable RSSI. */
      strongDominance: z.number().min(0.5).max(1),
      minReadsForDominance: z.int().min(1).max(10_000),
      /** Persistence (0-1) in both zones above which sequential sessions suggest movement. */
      movementPersistence: unit,
    }),
    weights: z.object({
      exclusivity: unit,
      persistence: unit,
      rssi: unit,
      anchor: unit,
    }),
    bands: z.object({
      /** Minimum evidence score for acceptance. */
      high: z.number().min(50).max(100),
      medium: z.number().min(0).max(100),
    }),
    rules: z.object({
      /** EPC + zone only data: accept single-zone EPCs by rule (no score). */
      acceptSingleZoneWithoutSignal: z.boolean(),
      /** Exclude single-zone EPCs whose RSSI is far below a calibrated zone threshold. */
      rejectBelowCalibratedThreshold: z.boolean(),
      /** Review multi-zone EPCs strongly observed in both zones in sequential sessions. */
      reviewPossibleMovement: z.boolean(),
    }),
    anchors: z.object({
      enabled: z.boolean(),
      /** 0-1 multiplier on the anchor weight; keep low until validated by calibration. */
      reliability: unit,
      marginDb: z.number().min(0).max(30),
    }),
    /** Store-specific calibration keyed by zone code. */
    zoneCalibration: z.record(
      z.string(),
      z.object({
        /** Median RSSI below which a single-zone read is considered weak (calibrated, dBm). */
        weakRssiThreshold: z.number().min(-200).max(0).nullable(),
      }),
    ),
  })
  .superRefine((p, ctx) => {
    if (p.epc.minLength > p.epc.maxLength)
      ctx.addIssue({ code: "custom", path: ["epc", "minLength"], message: "minLength must be <= maxLength" });
    if (p.rssi.validMin >= p.rssi.validMax)
      ctx.addIssue({ code: "custom", path: ["rssi", "validMin"], message: "validMin must be < validMax" });
    if (p.bands.medium >= p.bands.high)
      ctx.addIssue({
        code: "custom",
        path: ["bands", "medium"],
        message: "medium band must be below high band",
      });
    if (p.bands.high < 70)
      ctx.addIssue({
        code: "custom",
        path: ["bands", "high"],
        message: "Acceptance threshold below 70 is unsafe for an uncalibrated heuristic score",
      });
    const w = p.weights;
    if (w.exclusivity + w.persistence + w.rssi + w.anchor <= 0)
      ctx.addIssue({ code: "custom", path: ["weights"], message: "At least one weight must be positive" });
    if (w.exclusivity === 0)
      ctx.addIssue({
        code: "custom",
        path: ["weights", "exclusivity"],
        message: "Exclusivity weight must be positive (zone observation is always available)",
      });
    if (
      p.rules.rejectBelowCalibratedThreshold &&
      !Object.values(p.zoneCalibration).some((z) => z.weakRssiThreshold !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["rules", "rejectBelowCalibratedThreshold"],
        message: "Requires at least one calibrated zone weakRssiThreshold",
      });
  });

export type ProcessingProfileConfig = z.infer<typeof processingProfileSchema>;

export const DEFAULT_PROFILE: ProcessingProfileConfig = {
  epc: {
    format: "HEX",
    minLength: 8,
    maxLength: 128,
    lengthMultipleOf: 4,
    removeSeparators: true,
    stripHexPrefix: true,
    malformedPolicy: "FLAG",
  },
  duplicates: { policy: "AUTO" },
  invalidRows: { maxInvalidRowRatio: 0.5 },
  timing: { observationWindowSeconds: 5, maxSessionGapHours: 24 },
  rssi: { validMin: -120, validMax: 10, marginForFullSupportDb: 10, requireSameReader: true },
  evidence: {
    minReadsForFullSupport: 5,
    minWindowsForFullSupport: 3,
    strongDominance: 0.9,
    minReadsForDominance: 5,
    movementPersistence: 0.67,
  },
  weights: { exclusivity: 0.4, persistence: 0.2, rssi: 0.25, anchor: 0.15 },
  bands: { high: 85, medium: 60 },
  rules: {
    acceptSingleZoneWithoutSignal: true,
    rejectBelowCalibratedThreshold: false,
    reviewPossibleMovement: true,
  },
  anchors: { enabled: true, reliability: 0.5, marginDb: 3 },
  zoneCalibration: {},
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

/** Merge a partial profile over the defaults and validate. Throws ZodError on invalid input. */
export function resolveProfile(
  partial: DeepPartial<ProcessingProfileConfig> | unknown = {},
): ProcessingProfileConfig {
  return processingProfileSchema.parse(deepMerge(DEFAULT_PROFILE, partial ?? {}));
}

export function safeResolveProfile(partial: unknown) {
  return processingProfileSchema.safeParse(deepMerge(DEFAULT_PROFILE, partial ?? {}));
}
