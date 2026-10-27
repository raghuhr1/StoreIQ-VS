/**
 * Core types for the RFID cleaning engine. The engine is pure and
 * deterministic: no I/O, no clock, no randomness, no framework imports.
 */

export const ZONE_TYPES = [
  "SALES_FLOOR",
  "BACK_ROOM",
  "RECEIVING",
  "DISPATCH",
  "FITTING_ROOM",
  "OTHER",
] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export interface ZoneRef {
  id: string;
  code: string;
  name: string;
  type: ZoneType;
  aliases: string[];
  sortOrder: number;
}

export type ZoneRelation = "ADJACENT" | "DOORWAY" | "SHARED_WALL" | "SEPARATED";

export interface ZoneRelationshipRef {
  fromZoneId: string;
  toZoneId: string;
  relation: ZoneRelation;
}

export interface AnchorRef {
  epc: string; // normalized
  zoneId: string;
}

export const CANONICAL_FIELDS = [
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
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** Canonical field -> source column header. */
export type ColumnMapping = Partial<Record<CanonicalField, string>>;

export const DATE_FORMATS = ["AUTO", "ISO", "MDY", "DMY", "EPOCH_S", "EPOCH_MS"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Per-file context supplied when mapping rows. */
export interface FileContext {
  uploadId: string;
  mapping: ColumnMapping;
  /** Pattern A: the whole file belongs to this zone. */
  fixedZoneId: string | null;
  /** Session label used when no session column is mapped. */
  sessionLabel: string;
  /** Raw zone value (as in the file) -> zone id. */
  zoneValueMap: Record<string, string>;
  dateFormat: DateFormat;
  /** IANA time zone used for timestamps without an offset. */
  timeZone: string;
}

export interface Observation {
  uploadId: string;
  rowNumber: number;
  epcRaw: string;
  epc: string;
  epcValid: boolean;
  epcIssue: string | null;
  zoneId: string;
  /** Unique within a job: `${uploadId}::${externalSessionId}`. */
  sessionKey: string;
  sessionExternalId: string;
  timestamp: number | null; // epoch ms (UTC)
  rssi: number | null;
  readCount: number | null;
  phase: number | null;
  readerId: string | null;
  antennaId: string | null;
  channel: number | null;
  txPower: number | null;
  anchorFlag: boolean | null;
  /** File-level zone and row zone label disagreed. */
  labelConflict: boolean;
}

export type IssueSeverity = "error" | "warning";

export interface RowIssue {
  uploadId: string;
  rowNumber: number;
  code: string;
  message: string;
  field?: CanonicalField;
  severity: IssueSeverity;
}

export interface RssiStats {
  count: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export type DataQualityStatus =
  "OK" | "PARTIAL_EVIDENCE" | "NO_SIGNAL_DATA" | "SPARSE" | "CONFLICTING_ZONE_LABEL" | "MALFORMED_EPC";

export interface EpcZoneSummary {
  epc: string;
  zoneId: string;
  rowCount: number;
  /** Sum of read counts; rows without a read count contribute 1 (lower bound). */
  rawReadCount: number;
  /** False when at least one row lacked a read count. */
  readCountComplete: boolean;
  /** Distinct observation windows; null when timestamps are unavailable. */
  windowCount: number | null;
  sessionKeys: string[];
  firstSeen: number | null;
  lastSeen: number | null;
  rssi: RssiStats | null;
  readerIds: string[];
  antennaIds: string[];
  phaseAvailable: boolean;
  labelConflict: boolean;
  dataQualityStatus: DataQualityStatus;
}

export interface EpcAggregate {
  epc: string;
  epcRaw: string;
  epcValid: boolean;
  epcIssue: string | null;
  /** Sorted by zone sortOrder then code. */
  zones: EpcZoneSummary[];
}

export interface AnchorSessionStat {
  anchorEpc: string;
  /** Registered zone of the anchor; null when flagged in the file but not registered. */
  zoneId: string | null;
  reads: number;
  medianRssi: number | null;
}

export interface SessionSummary {
  key: string;
  uploadId: string;
  externalId: string;
  /** Zone labels seen in the session (normally exactly one). */
  zoneIds: string[];
  startedAt: number | null;
  endedAt: number | null;
  rowCount: number;
  uniqueEpcCount: number;
  anchors: AnchorSessionStat[];
}

export type SessionPairRelation = "OVERLAPPING" | "SEQUENTIAL" | "FAR_APART" | "UNKNOWN_TIMING";

export interface SessionPair {
  a: string;
  b: string;
  relation: SessionPairRelation;
  gapMs: number | null;
}

export interface JobWarning {
  code: string;
  message: string;
}

export interface AggregationResult {
  epcs: EpcAggregate[];
  sessions: SessionSummary[];
  sessionPairs: SessionPair[];
  anchorEpcs: string[];
  stats: {
    validRowCount: number;
    duplicateObservationCount: number;
    anchorObservationCount: number;
    /** Whether row counts / read counts carry information about read strength. */
    readEvidenceInformative: boolean;
    timestampsAvailable: boolean;
    rssiAvailable: boolean;
    phaseAvailable: boolean;
  };
  warnings: JobWarning[];
}

export type ClassificationValue = "ACCEPTED" | "NEEDS_REVIEW" | "REJECTED_FROM_ZONE";

export type ConfidenceType = "HEURISTIC_EVIDENCE_SCORE" | "RULE_BASED_NO_SCORE" | "NOT_SCORED_DATA_QUALITY";

export type EvidenceKind =
  "ZONE_OBSERVATION" | "READ_COUNTS" | "TIMESTAMPS" | "RSSI" | "ANCHORS" | "PHASE_NOT_USED";

export interface ZoneDisposition {
  zoneId: string;
  disposition: ClassificationValue;
  reasonCode: string;
}

export interface ScoreComponent {
  name: "exclusivity" | "persistence" | "rssi" | "anchor";
  available: boolean;
  support: number | null; // 0..1
  weight: number;
  note: string;
}

export interface ClassificationResult {
  epc: string;
  epcRaw: string;
  observedZoneIds: string[];
  classification: ClassificationValue;
  assignedZoneId: string | null;
  /** Zone the evidence leans towards, also for review items. Never used as an assignment. */
  suggestedZoneId: string | null;
  confidenceScore: number | null;
  confidenceType: ConfidenceType;
  confidenceBand: "HIGH" | "MEDIUM" | "LOW" | null;
  reasonCode: string;
  reasonDescription: string;
  recommendedAction: string;
  evidenceAvailable: EvidenceKind[];
  rulesFired: string[];
  requiresManualReview: boolean;
  zoneDispositions: ZoneDisposition[];
  components: ScoreComponent[];
}
