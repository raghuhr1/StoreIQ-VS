import type { ProcessingProfileConfig } from "./profile";
import type {
  AggregationResult,
  AnchorRef,
  AnchorSessionStat,
  DataQualityStatus,
  EpcAggregate,
  EpcZoneSummary,
  JobWarning,
  Observation,
  RssiStats,
  SessionPair,
  SessionSummary,
  ZoneRef,
} from "./types";

interface ZoneAcc {
  rowCount: number;
  readSum: number;
  missingReadCount: number;
  minTs: number | null;
  maxTs: number | null;
  windows: Set<number>;
  sessions: Set<string>;
  rssi: number[];
  readers: Set<string>;
  antennas: Set<string>;
  phase: boolean;
  labelConflict: boolean;
}

interface EpcAcc {
  epcRaw: string;
  valid: boolean;
  issue: string | null;
  zones: Map<string, ZoneAcc>;
}

interface SessionAcc {
  key: string;
  uploadId: string;
  externalId: string;
  zoneIds: Set<string>;
  minTs: number | null;
  maxTs: number | null;
  rowCount: number;
  epcs: Set<string>;
  anchors: Map<string, { zoneId: string | null; reads: number; rssi: number[] }>;
}

export interface FileEvidenceFlags {
  readCountMapped: boolean;
  timestampMapped: boolean;
}

export interface AddResult {
  duplicate: boolean;
  anchor: boolean;
}

/** 53-bit string hash (cyrb53). Used only within one EPC's duplicate set. */
function hash53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function rssiStats(values: number[]): RssiStats | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    count: s.length,
    median: round2(quantile(s, 0.5)),
    p25: round2(quantile(s, 0.25)),
    p75: round2(quantile(s, 0.75)),
    min: s[0],
    max: s[s.length - 1],
  };
}

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Streaming aggregation of observations into per-EPC, per-zone summaries.
 * Memory grows with unique EPC×zone pairs and RSSI values, not raw rows.
 */
export class Aggregator {
  private epcs = new Map<string, EpcAcc>();
  private sessions = new Map<string, SessionAcc>();
  private dupKeys = new Map<string, Set<number>>();
  private files = new Map<string, FileEvidenceFlags>();
  private anchorMap: Map<string, string>;
  private zoneOrder: Map<string, number>;
  private validRows = 0;
  private duplicateRows = 0;
  private anchorRows = 0;
  private anyReadCount = false;
  private anyTimestamp = false;
  private anyRssi = false;
  private anyPhase = false;
  private unregisteredAnchorFlags = new Set<string>();

  constructor(
    private profile: ProcessingProfileConfig,
    private zones: ZoneRef[],
    anchors: AnchorRef[],
  ) {
    this.anchorMap = new Map(profile.anchors.enabled ? anchors.map((a) => [a.epc, a.zoneId]) : []);
    const sorted = [...zones].sort((a, b) => a.sortOrder - b.sortOrder || byStr(a.code, b.code));
    this.zoneOrder = new Map(sorted.map((z, i) => [z.id, i]));
  }

  registerFile(uploadId: string, flags: FileEvidenceFlags) {
    this.files.set(uploadId, flags);
  }

  private collapseDuplicates(uploadId: string) {
    const policy = this.profile.duplicates.policy;
    if (policy === "COLLAPSE") return true;
    if (policy === "COUNT_AS_READS") return false;
    const f = this.files.get(uploadId);
    return !!f && (f.readCountMapped || f.timestampMapped);
  }

  add(o: Observation): AddResult {
    this.validRows++;
    // Exact-duplicate detection (keyed per EPC so a hash collision can never drop an EPC).
    const key = [
      o.zoneId,
      o.sessionKey,
      o.timestamp,
      o.rssi,
      o.readCount,
      o.phase,
      o.readerId,
      o.antennaId,
      o.channel,
      o.txPower,
    ].join("|");
    const h = hash53(key);
    let set = this.dupKeys.get(o.epc);
    if (!set) this.dupKeys.set(o.epc, (set = new Set()));
    const isDuplicate = set.has(h);
    set.add(h);
    if (isDuplicate) this.duplicateRows++;
    if (isDuplicate && this.collapseDuplicates(o.uploadId))
      return { duplicate: true, anchor: this.isAnchor(o) };

    const session = this.session(o);
    session.rowCount++;
    if (o.timestamp !== null) {
      session.minTs = session.minTs === null ? o.timestamp : Math.min(session.minTs, o.timestamp);
      session.maxTs = session.maxTs === null ? o.timestamp : Math.max(session.maxTs, o.timestamp);
    }

    if (this.isAnchor(o)) {
      this.anchorRows++;
      const registered = this.anchorMap.get(o.epc) ?? null;
      if (registered === null) this.unregisteredAnchorFlags.add(o.epc);
      let a = session.anchors.get(o.epc);
      if (!a) session.anchors.set(o.epc, (a = { zoneId: registered, reads: 0, rssi: [] }));
      a.reads += o.readCount ?? 1;
      if (o.rssi !== null) a.rssi.push(o.rssi);
      return { duplicate: isDuplicate, anchor: true };
    }

    session.epcs.add(o.epc);
    let e = this.epcs.get(o.epc);
    if (!e)
      this.epcs.set(
        o.epc,
        (e = { epcRaw: o.epcRaw, valid: o.epcValid, issue: o.epcIssue, zones: new Map() }),
      );
    let z = e.zones.get(o.zoneId);
    if (!z) {
      z = {
        rowCount: 0,
        readSum: 0,
        missingReadCount: 0,
        minTs: null,
        maxTs: null,
        windows: new Set(),
        sessions: new Set(),
        rssi: [],
        readers: new Set(),
        antennas: new Set(),
        phase: false,
        labelConflict: false,
      };
      e.zones.set(o.zoneId, z);
    }
    z.rowCount++;
    if (o.readCount !== null) {
      z.readSum += o.readCount;
      this.anyReadCount = true;
    } else {
      z.readSum += 1; // a row implies at least one read; never zero
      z.missingReadCount++;
    }
    if (o.timestamp !== null) {
      this.anyTimestamp = true;
      z.minTs = z.minTs === null ? o.timestamp : Math.min(z.minTs, o.timestamp);
      z.maxTs = z.maxTs === null ? o.timestamp : Math.max(z.maxTs, o.timestamp);
      z.windows.add(Math.floor(o.timestamp / (this.profile.timing.observationWindowSeconds * 1000)));
    }
    if (o.rssi !== null) {
      this.anyRssi = true;
      z.rssi.push(o.rssi);
    }
    if (o.phase !== null) this.anyPhase = z.phase = true;
    if (o.readerId) z.readers.add(o.readerId);
    if (o.antennaId) z.antennas.add(o.antennaId);
    if (o.labelConflict) z.labelConflict = true;
    z.sessions.add(o.sessionKey);
    return { duplicate: isDuplicate, anchor: false };
  }

  private isAnchor(o: Observation) {
    return this.anchorMap.has(o.epc) || (this.profile.anchors.enabled && o.anchorFlag === true);
  }

  private session(o: Observation): SessionAcc {
    let s = this.sessions.get(o.sessionKey);
    if (!s) {
      s = {
        key: o.sessionKey,
        uploadId: o.uploadId,
        externalId: o.sessionExternalId,
        zoneIds: new Set(),
        minTs: null,
        maxTs: null,
        rowCount: 0,
        epcs: new Set(),
        anchors: new Map(),
      };
      this.sessions.set(o.sessionKey, s);
    }
    s.zoneIds.add(o.zoneId);
    return s;
  }

  finalize(): AggregationResult {
    const p = this.profile;
    let maxRowsPerPair = 0;
    for (const e of this.epcs.values())
      for (const z of e.zones.values()) maxRowsPerPair = Math.max(maxRowsPerPair, z.rowCount);
    const readEvidenceInformative = this.anyReadCount || maxRowsPerPair > 1;
    const windowEvidenceInformative = this.anyTimestamp && maxRowsPerPair > 1;
    const zoneRank = (id: string) => this.zoneOrder.get(id) ?? Number.MAX_SAFE_INTEGER;

    const epcs: EpcAggregate[] = [];
    for (const epc of [...this.epcs.keys()].sort(byStr)) {
      const e = this.epcs.get(epc)!;
      const zones: EpcZoneSummary[] = [...e.zones.entries()]
        .sort(([a], [b]) => zoneRank(a) - zoneRank(b) || byStr(a, b))
        .map(([zoneId, z]) => {
          const rssi = rssiStats(z.rssi);
          const windowCount = z.minTs !== null && windowEvidenceInformative ? z.windows.size : null;
          let dq: DataQualityStatus;
          if (!e.valid) dq = "MALFORMED_EPC";
          else if (z.labelConflict) dq = "CONFLICTING_ZONE_LABEL";
          else if (readEvidenceInformative && z.readSum <= 1 && (windowCount ?? 1) <= 1) dq = "SPARSE";
          else if (!rssi && z.minTs === null && !readEvidenceInformative) dq = "NO_SIGNAL_DATA";
          else if (!rssi || z.minTs === null) dq = "PARTIAL_EVIDENCE";
          else dq = "OK";
          return {
            epc,
            zoneId,
            rowCount: z.rowCount,
            rawReadCount: z.readSum,
            readCountComplete: z.missingReadCount === 0,
            windowCount,
            sessionKeys: [...z.sessions].sort(byStr),
            firstSeen: z.minTs,
            lastSeen: z.maxTs,
            rssi,
            readerIds: [...z.readers].sort(byStr),
            antennaIds: [...z.antennas].sort(byStr),
            phaseAvailable: z.phase,
            labelConflict: z.labelConflict,
            dataQualityStatus: dq,
          };
        });
      epcs.push({ epc, epcRaw: e.epcRaw, epcValid: e.valid, epcIssue: e.issue, zones });
    }

    const sessions: SessionSummary[] = [...this.sessions.values()]
      .sort((a, b) => byStr(a.key, b.key))
      .map((s) => ({
        key: s.key,
        uploadId: s.uploadId,
        externalId: s.externalId,
        zoneIds: [...s.zoneIds].sort((a, b) => zoneRank(a) - zoneRank(b) || byStr(a, b)),
        startedAt: s.minTs,
        endedAt: s.maxTs,
        rowCount: s.rowCount,
        uniqueEpcCount: s.epcs.size,
        anchors: [...s.anchors.entries()]
          .sort(([a], [b]) => byStr(a, b))
          .map(([anchorEpc, a]): AnchorSessionStat => ({
            anchorEpc,
            zoneId: a.zoneId,
            reads: a.reads,
            medianRssi: rssiStats(a.rssi)?.median ?? null,
          })),
      }));

    const sessionPairs = computeSessionPairs(sessions, p.timing.maxSessionGapHours);
    const warnings: JobWarning[] = [];
    if (!this.anyTimestamp)
      warnings.push({
        code: "NO_TIMESTAMPS",
        message: "No timestamps in the input: temporal inference and session timing are unavailable.",
      });
    else if (!windowEvidenceInformative)
      warnings.push({
        code: "TIMESTAMPS_NOT_PER_READ",
        message:
          "Timestamps appear to be one per EPC and zone; observation windows are not used as evidence.",
      });
    if (!this.anyRssi)
      warnings.push({
        code: "NO_RSSI",
        message: "No RSSI in the input: signal-strength evidence is unavailable.",
      });
    if (!readEvidenceInformative)
      warnings.push({
        code: "NO_READ_EVIDENCE",
        message:
          "Input has one row per EPC and zone without read counts: read-strength evidence is unavailable.",
      });
    if (this.anyPhase)
      warnings.push({
        code: "PHASE_NOT_USED",
        message: "Phase values were recorded but are not used for classification (not validated).",
      });
    for (const s of sessions)
      if (s.zoneIds.length > 1)
        warnings.push({
          code: "SESSION_MIXED_ZONES",
          message: `Scan session "${s.externalId}" contains rows labelled with ${s.zoneIds.length} different zones.`,
        });
    for (const pr of sessionPairs) {
      if (pr.relation === "FAR_APART")
        warnings.push({
          code: "SESSIONS_FAR_APART",
          message: `Sessions ${this.sessions.get(pr.a)!.externalId} and ${this.sessions.get(pr.b)!.externalId} are more than ${p.timing.maxSessionGapHours} h apart; EPCs seen in both are sent to review.`,
        });
      if (pr.relation === "OVERLAPPING")
        warnings.push({
          code: "SESSIONS_OVERLAP",
          message: `Sessions ${this.sessions.get(pr.a)!.externalId} and ${this.sessions.get(pr.b)!.externalId} overlap in time (concurrent scanning in different zones).`,
        });
    }
    if (this.unregisteredAnchorFlags.size > 0)
      warnings.push({
        code: "ANCHOR_FLAG_UNREGISTERED",
        message: `${this.unregisteredAnchorFlags.size} EPC(s) flagged as anchors in the file are not registered; excluded from inventory but not used as evidence.`,
      });
    if (p.anchors.enabled && this.anchorMap.size > 0 && this.anchorRows === 0)
      warnings.push({
        code: "ANCHORS_NOT_OBSERVED",
        message:
          "Registered anchors were not observed. Anchor evidence is unavailable; this is not evidence about reader location.",
      });

    const anchorEpcs = new Set<string>();
    for (const s of sessions) for (const a of s.anchors) anchorEpcs.add(a.anchorEpc);

    return {
      epcs,
      sessions,
      sessionPairs,
      anchorEpcs: [...anchorEpcs].sort(byStr),
      stats: {
        validRowCount: this.validRows,
        duplicateObservationCount: this.duplicateRows,
        anchorObservationCount: this.anchorRows,
        readEvidenceInformative,
        timestampsAvailable: this.anyTimestamp,
        rssiAvailable: this.anyRssi,
        phaseAvailable: this.anyPhase,
      },
      warnings,
    };
  }
}

function computeSessionPairs(sessions: SessionSummary[], maxGapHours: number): SessionPair[] {
  const pairs: SessionPair[] = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (a.zoneIds.join() === b.zoneIds.join()) continue; // only compare sessions of different zones
      if (a.startedAt === null || a.endedAt === null || b.startedAt === null || b.endedAt === null) {
        pairs.push({ a: a.key, b: b.key, relation: "UNKNOWN_TIMING", gapMs: null });
        continue;
      }
      const overlap = a.startedAt <= b.endedAt && b.startedAt <= a.endedAt;
      const gapMs = overlap ? 0 : Math.max(b.startedAt - a.endedAt, a.startedAt - b.endedAt);
      const relation = overlap ? "OVERLAPPING" : gapMs > maxGapHours * 3_600_000 ? "FAR_APART" : "SEQUENTIAL";
      pairs.push({ a: a.key, b: b.key, relation, gapMs });
    }
  }
  return pairs;
}
