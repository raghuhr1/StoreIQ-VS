import type { ProcessingProfileConfig } from "./profile";
import type {
  AggregationResult,
  ClassificationResult,
  ClassificationValue,
  ConfidenceType,
  EpcAggregate,
  EpcZoneSummary,
  EvidenceKind,
  ScoreComponent,
  SessionPairRelation,
  SessionSummary,
  ZoneDisposition,
  ZoneRef,
  ZoneRelationshipRef,
} from "./types";

export interface ClassifyContext {
  profile: ProcessingProfileConfig;
  zones: ZoneRef[];
  relationships: ZoneRelationshipRef[];
  aggregation: AggregationResult;
}

/** Reason catalogue: code -> recommended action. Descriptions are built per EPC. */
export const RECOMMENDED_ACTIONS: Record<string, string> = {
  SINGLE_ZONE_RULE_ONLY: "None. Accepted by rule; no signal data was available to score it.",
  SINGLE_ZONE_STRONG_EVIDENCE: "None.",
  MULTI_ZONE_RESOLVED: "None. Spot-check a sample of resolved cross-reads during the pilot.",
  CROSS_READ_EXCLUDED: "None. Excluded from this zone because the evidence places the item in another zone.",
  MALFORMED_EPC: "Check the tag ID and the EPC format settings of the processing profile.",
  CONFLICTING_ZONE_LABELS:
    "Confirm which zone the file or rows belong to and re-upload with the correct zone.",
  SPARSE_OBSERVATION: "Verify the item's location physically or re-scan the zone.",
  LOW_EVIDENCE_SCORE: "Verify the item's location physically.",
  INSUFFICIENT_EVIDENCE: "Verify the item's location physically.",
  MULTI_ZONE_NO_SIGNAL_EVIDENCE:
    "Verify the item's location. Exporting RSSI or read counts enables automatic resolution.",
  MULTI_ZONE_INSUFFICIENT_EVIDENCE: "Verify the item's location physically.",
  MULTI_ZONE_TIED: "Verify the item's location physically.",
  MULTI_ZONE_AMBIGUOUS: "Verify the item's location physically.",
  CONFLICTING_SIGNAL_EVIDENCE: "Verify the item's location; signal strength and read counts disagree.",
  POSSIBLE_MOVEMENT: "The item may have moved between scans. Verify its current location.",
  SESSIONS_NOT_CONTEMPORANEOUS: "Scans are far apart in time. Re-scan both zones within one inventory cycle.",
  ANCHOR_EVIDENCE_CONFLICT:
    "Verify the item's location; anchor-tag evidence contradicts the zone assignment.",
  NON_ADJACENT_ZONES: "Observed in zones configured as separated. Check zone labels and file assignments.",
  WEAK_SIGNAL_BELOW_CALIBRATED_THRESHOLD:
    "Verify the item's location; it is likely read through from an adjacent zone.",
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Decision {
  classification: ClassificationValue;
  assignedZoneId: string | null;
  reasonCode: string;
  reasonDescription: string;
  confidenceType: ConfidenceType;
  score: number | null;
  rulesFired: string[];
  components: ScoreComponent[];
  dispositions: ZoneDisposition[];
  candidateZoneId: string | null;
}

export function classifyAll(ctx: ClassifyContext): ClassificationResult[] {
  const { profile: p, aggregation: agg } = ctx;
  const zoneById = new Map(ctx.zones.map((z) => [z.id, z]));
  const zoneLabel = (id: string) => zoneById.get(id)?.name ?? id;
  const sessionByKey = new Map(agg.sessions.map((s) => [s.key, s]));
  const pairRel = new Map<string, SessionPairRelation>();
  for (const pr of agg.sessionPairs) {
    pairRel.set(`${pr.a}|${pr.b}`, pr.relation);
    pairRel.set(`${pr.b}|${pr.a}`, pr.relation);
  }
  const separated = new Set(
    ctx.relationships
      .filter((r) => r.relation === "SEPARATED")
      .flatMap((r) => [`${r.fromZoneId}|${r.toZoneId}`, `${r.toZoneId}|${r.fromZoneId}`]),
  );
  const readInfo = agg.stats.readEvidenceInformative;

  const persistence = (z: EpcZoneSummary): number | null => {
    if (z.windowCount !== null) return clamp01(z.windowCount / p.evidence.minWindowsForFullSupport);
    if (readInfo) return clamp01(z.rawReadCount / p.evidence.minReadsForFullSupport);
    return null;
  };

  const calibratedThreshold = (zoneId: string) => {
    const code = zoneById.get(zoneId)?.code;
    return code ? (p.zoneCalibration[code]?.weakRssiThreshold ?? null) : null;
  };

  const anchorComponent = (z: EpcZoneSummary, zoneId: string): ScoreComponent => {
    const weight = p.weights.anchor * p.anchors.reliability;
    const off = (note: string): ScoreComponent => ({
      name: "anchor",
      available: false,
      support: null,
      weight,
      note,
    });
    if (!p.anchors.enabled) return off("Anchor evidence disabled");
    const supports: number[] = [];
    for (const key of z.sessionKeys) {
      const s: SessionSummary | undefined = sessionByKey.get(key);
      if (!s) continue;
      const registered = s.anchors.filter((a) => a.zoneId !== null);
      const other = registered.filter((a) => a.zoneId !== zoneId);
      const own = registered.filter((a) => a.zoneId === zoneId);
      if (other.length > 0) {
        const otherRssi = other.map((a) => a.medianRssi).filter((v): v is number => v !== null);
        if (otherRssi.length > 0 && z.rssi) {
          const otherMax = Math.max(...otherRssi);
          if (z.rssi.median > otherMax + p.anchors.marginDb) supports.push(0.8);
          else if (z.rssi.median < otherMax - p.anchors.marginDb) supports.push(0.15);
          else supports.push(0.4);
        } else supports.push(0.4);
      } else if (own.length > 0) supports.push(0.6);
    }
    if (supports.length === 0)
      return off("No registered anchors observed in this EPC's sessions (not evidence either way)");
    const support = supports.reduce((a, b) => a + b, 0) / supports.length;
    return {
      name: "anchor",
      available: true,
      support,
      weight,
      note: `Anchor evidence from ${supports.length} session(s), reliability ${p.anchors.reliability}`,
    };
  };

  const score = (components: ScoreComponent[]) => {
    const avail = components.filter((c) => c.available && c.weight > 0);
    const wsum = avail.reduce((a, c) => a + c.weight, 0);
    if (wsum === 0) return null;
    return round1((100 * avail.reduce((a, c) => a + c.weight * (c.support ?? 0), 0)) / wsum);
  };

  const sessionsRelation = (a: EpcZoneSummary, b: EpcZoneSummary) => {
    const rels = new Set<SessionPairRelation>();
    for (const ka of a.sessionKeys)
      for (const kb of b.sessionKeys) rels.add(pairRel.get(`${ka}|${kb}`) ?? "UNKNOWN_TIMING");
    return rels;
  };

  const review = (
    code: string,
    description: string,
    extra: Partial<Decision> & { zones: EpcZoneSummary[] },
  ): Decision => ({
    classification: "NEEDS_REVIEW",
    assignedZoneId: null,
    reasonCode: code,
    reasonDescription: description,
    confidenceType: extra.confidenceType ?? "HEURISTIC_EVIDENCE_SCORE",
    score: extra.score ?? null,
    rulesFired: extra.rulesFired ?? [code],
    components: extra.components ?? [],
    dispositions: extra.zones.map((z) => ({
      zoneId: z.zoneId,
      disposition: "NEEDS_REVIEW",
      reasonCode: code,
    })),
    candidateZoneId: extra.candidateZoneId ?? null,
  });

  function decideSingle(e: EpcAggregate): Decision {
    const z = e.zones[0];
    const zones = e.zones;
    const where = zoneLabel(z.zoneId);
    if (!e.epcValid)
      return review("MALFORMED_EPC", `EPC failed format validation (${e.epcIssue}); observed in ${where}`, {
        zones,
        confidenceType: "NOT_SCORED_DATA_QUALITY",
      });

    const pers = persistence(z);
    const thr = calibratedThreshold(z.zoneId);
    const components: ScoreComponent[] = [
      {
        name: "exclusivity",
        available: true,
        support: 1,
        weight: p.weights.exclusivity,
        note: `Observed only in ${where}`,
      },
      {
        name: "persistence",
        available: pers !== null,
        support: pers,
        weight: p.weights.persistence,
        note:
          z.windowCount !== null
            ? `${z.windowCount} observation window(s)`
            : pers !== null
              ? `${z.rawReadCount} read(s)${z.readCountComplete ? "" : " (lower bound)"}`
              : "No read-count or per-read timing data",
      },
      thr !== null && z.rssi
        ? {
            name: "rssi",
            available: true,
            support: clamp01(0.5 + (z.rssi.median - thr) / (2 * p.rssi.marginForFullSupportDb)),
            weight: p.weights.rssi,
            note: `Median RSSI ${z.rssi.median} dBm vs calibrated threshold ${thr} dBm`,
          }
        : {
            name: "rssi",
            available: false,
            support: null,
            weight: p.weights.rssi,
            note: z.rssi ? "No calibrated RSSI threshold for this zone; absolute RSSI not used" : "No RSSI",
          },
      anchorComponent(z, z.zoneId),
    ];
    const signal = components.some((c) => c.name !== "exclusivity" && c.available);

    if (z.labelConflict)
      return review(
        "CONFLICTING_ZONE_LABELS",
        `Rows for this EPC carry a zone label that differs from the file's zone (${where})`,
        {
          zones,
          components,
          score: signal ? score(components) : null,
          confidenceType: signal ? "HEURISTIC_EVIDENCE_SCORE" : "RULE_BASED_NO_SCORE",
        },
      );

    if (!signal) {
      if (p.rules.acceptSingleZoneWithoutSignal)
        return {
          classification: "ACCEPTED",
          assignedZoneId: z.zoneId,
          reasonCode: "SINGLE_ZONE_RULE_ONLY",
          reasonDescription: `Observed only in ${where}; no RSSI, timing or read-count data to score`,
          confidenceType: "RULE_BASED_NO_SCORE",
          score: null,
          rulesFired: ["SINGLE_ZONE_RULE_ONLY"],
          components,
          dispositions: [{ zoneId: z.zoneId, disposition: "ACCEPTED", reasonCode: "SINGLE_ZONE_RULE_ONLY" }],
          candidateZoneId: z.zoneId,
        };
      return review(
        "INSUFFICIENT_EVIDENCE",
        `Observed only in ${where}; no signal data and rule-only acceptance is disabled`,
        {
          zones,
          components,
          confidenceType: "RULE_BASED_NO_SCORE",
        },
      );
    }

    const s = score(components)!;
    const anchor = components[3];
    if (anchor.available && (anchor.support ?? 1) <= 0.2)
      return review(
        "ANCHOR_EVIDENCE_CONFLICT",
        `Anchor evidence suggests the reader in ${where} was reading another zone at this signal level`,
        {
          zones,
          components,
          score: s,
          candidateZoneId: z.zoneId,
          rulesFired: ["ANCHOR_EVIDENCE_CONFLICT"],
        },
      );
    if (
      p.rules.rejectBelowCalibratedThreshold &&
      thr !== null &&
      z.rssi &&
      z.rssi.median < thr - p.rssi.marginForFullSupportDb
    )
      return {
        classification: "REJECTED_FROM_ZONE",
        assignedZoneId: null,
        reasonCode: "WEAK_SIGNAL_BELOW_CALIBRATED_THRESHOLD",
        reasonDescription: `Excluded from ${where}: median RSSI ${z.rssi.median} dBm is more than ${p.rssi.marginForFullSupportDb} dB below the calibrated threshold ${thr} dBm`,
        confidenceType: "HEURISTIC_EVIDENCE_SCORE",
        score: s,
        rulesFired: ["WEAK_SIGNAL_BELOW_CALIBRATED_THRESHOLD"],
        components,
        dispositions: [
          {
            zoneId: z.zoneId,
            disposition: "REJECTED_FROM_ZONE",
            reasonCode: "WEAK_SIGNAL_BELOW_CALIBRATED_THRESHOLD",
          },
        ],
        candidateZoneId: null,
      };
    if (s >= p.bands.high)
      return {
        classification: "ACCEPTED",
        assignedZoneId: z.zoneId,
        reasonCode: "SINGLE_ZONE_STRONG_EVIDENCE",
        reasonDescription: `Observed only in ${where} with sufficient supporting evidence`,
        confidenceType: "HEURISTIC_EVIDENCE_SCORE",
        score: s,
        rulesFired: ["SCORE_ABOVE_ACCEPTANCE_THRESHOLD"],
        components,
        dispositions: [
          { zoneId: z.zoneId, disposition: "ACCEPTED", reasonCode: "SINGLE_ZONE_STRONG_EVIDENCE" },
        ],
        candidateZoneId: z.zoneId,
      };
    if (pers !== null && pers < 0.5)
      return review(
        "SPARSE_OBSERVATION",
        `Observed only in ${where} but too sparsely (${components[1].note}) for reliable classification`,
        {
          zones,
          components,
          score: s,
          candidateZoneId: z.zoneId,
          rulesFired: ["SCORE_BELOW_ACCEPTANCE_THRESHOLD", "SPARSE_OBSERVATION"],
        },
      );
    return review(
      "LOW_EVIDENCE_SCORE",
      `Observed only in ${where}; evidence score ${s} is below the acceptance threshold ${p.bands.high}`,
      {
        zones,
        components,
        score: s,
        candidateZoneId: z.zoneId,
        rulesFired: ["SCORE_BELOW_ACCEPTANCE_THRESHOLD"],
      },
    );
  }

  function decideMulti(e: EpcAggregate): Decision {
    const zones = e.zones;
    const names = zones.map((z) => zoneLabel(z.zoneId)).join(", ");
    if (!e.epcValid)
      return review("MALFORMED_EPC", `EPC failed format validation (${e.epcIssue}); observed in ${names}`, {
        zones,
        confidenceType: "NOT_SCORED_DATA_QUALITY",
      });
    if (zones.some((z) => z.labelConflict))
      return review("CONFLICTING_ZONE_LABELS", `Observed in ${names} with conflicting zone labels`, {
        zones,
        confidenceType: "NOT_SCORED_DATA_QUALITY",
      });
    for (let i = 0; i < zones.length; i++)
      for (let j = i + 1; j < zones.length; j++) {
        if (sessionsRelation(zones[i], zones[j]).has("FAR_APART"))
          return review(
            "SESSIONS_NOT_CONTEMPORANEOUS",
            `Observed in ${names} in scans more than ${p.timing.maxSessionGapHours} h apart`,
            {
              zones,
              confidenceType: "NOT_SCORED_DATA_QUALITY",
            },
          );
        if (separated.has(`${zones[i].zoneId}|${zones[j].zoneId}`))
          return review(
            "NON_ADJACENT_ZONES",
            `Observed in ${names}, which are configured as physically separated`,
            {
              zones,
              confidenceType: "NOT_SCORED_DATA_QUALITY",
            },
          );
      }

    const comparable = (a: EpcZoneSummary, b: EpcZoneSummary) =>
      !!a.rssi &&
      !!b.rssi &&
      (!p.rssi.requireSameReader ||
        a.readerIds.length === 0 ||
        b.readerIds.length === 0 ||
        a.readerIds.some((r) => b.readerIds.includes(r)));
    const allRssi = zones.every((z) => z.rssi);
    const byReads = [...zones].sort(
      (a, b) => b.rawReadCount - a.rawReadCount || (b.windowCount ?? 0) - (a.windowCount ?? 0),
    );
    const byRssi = allRssi
      ? [...zones].sort((a, b) => b.rssi!.median - a.rssi!.median || b.rawReadCount - a.rawReadCount)
      : null;
    const useRssi = !!byRssi && comparable(byRssi[0], byRssi[1]);
    const ordered = useRssi ? byRssi! : byReads;
    const [c, o] = ordered;
    const rssiComparable = comparable(c, o);

    if (!readInfo && !rssiComparable)
      return review(
        "MULTI_ZONE_NO_SIGNAL_EVIDENCE",
        `Observed in ${names}; no comparable RSSI or read-count data to distinguish the true zone`,
        { zones, confidenceType: "RULE_BASED_NO_SCORE", rulesFired: ["MULTI_ZONE_NO_SIGNAL_EVIDENCE"] },
      );
    const tied = rssiComparable
      ? c.rssi!.median === o.rssi!.median && c.rawReadCount === o.rawReadCount
      : c.rawReadCount === o.rawReadCount && (c.windowCount ?? 0) === (o.windowCount ?? 0);
    if (tied)
      return review(
        "MULTI_ZONE_TIED",
        `Observed in ${names} with equal evidence in ${zoneLabel(c.zoneId)} and ${zoneLabel(o.zoneId)}`,
        {
          zones,
          rulesFired: ["MULTI_ZONE_TIED"],
          score: 0,
        },
      );

    const persC = persistence(c);
    const persO = persistence(o);
    const dominance = readInfo ? c.rawReadCount / (c.rawReadCount + o.rawReadCount) : null;
    const components: ScoreComponent[] = [
      {
        name: "exclusivity",
        available: dominance !== null,
        support: dominance === null ? null : clamp01((dominance - 0.5) / 0.5),
        weight: p.weights.exclusivity,
        note:
          dominance === null
            ? `Observed in ${zones.length} zones; no read-count data`
            : `${c.rawReadCount} read(s) in ${zoneLabel(c.zoneId)} vs ${o.rawReadCount} in ${zoneLabel(o.zoneId)}`,
      },
      {
        name: "persistence",
        available: persC !== null && persO !== null,
        support: persC !== null && persO !== null ? clamp01(persC * (1 - persO / 2)) : null,
        weight: p.weights.persistence,
        note:
          c.windowCount !== null
            ? `${c.windowCount} window(s) in ${zoneLabel(c.zoneId)} vs ${o.windowCount ?? 0} in ${zoneLabel(o.zoneId)}`
            : "Persistence from read counts",
      },
      rssiComparable
        ? {
            name: "rssi",
            available: true,
            support: clamp01((c.rssi!.median - o.rssi!.median) / p.rssi.marginForFullSupportDb),
            weight: p.weights.rssi,
            note: `Median RSSI ${c.rssi!.median} dBm in ${zoneLabel(c.zoneId)} vs ${o.rssi!.median} dBm in ${zoneLabel(o.zoneId)}`,
          }
        : {
            name: "rssi",
            available: false,
            support: null,
            weight: p.weights.rssi,
            note:
              c.rssi && o.rssi
                ? "RSSI not comparable (different readers)"
                : "RSSI missing in at least one zone",
          },
      anchorComponent(c, c.zoneId),
    ];
    const s = score(components);
    const base = { zones, components, score: s, candidateZoneId: c.zoneId };
    const rules: string[] = [];

    // Critical rules: any of these forces review regardless of the score.
    if (
      p.rules.reviewPossibleMovement &&
      persC !== null &&
      persO !== null &&
      persC >= p.evidence.movementPersistence &&
      persO >= p.evidence.movementPersistence &&
      c.firstSeen !== null &&
      o.firstSeen !== null &&
      [...sessionsRelation(c, o)].every((r) => r === "SEQUENTIAL")
    )
      return review(
        "POSSIBLE_MOVEMENT",
        `Strongly observed in both ${zoneLabel(c.zoneId)} and ${zoneLabel(o.zoneId)} in sequential scans`,
        {
          ...base,
          rulesFired: ["POSSIBLE_MOVEMENT"],
        },
      );
    if (rssiComparable && readInfo && o.rawReadCount / (c.rawReadCount + o.rawReadCount) >= 0.75)
      return review(
        "CONFLICTING_SIGNAL_EVIDENCE",
        `RSSI favours ${zoneLabel(c.zoneId)} but read counts favour ${zoneLabel(o.zoneId)}`,
        { ...base, rulesFired: ["CONFLICTING_SIGNAL_EVIDENCE"] },
      );
    const anchor = components[3];
    if (anchor.available && (anchor.support ?? 1) <= 0.2)
      return review(
        "ANCHOR_EVIDENCE_CONFLICT",
        `Anchor evidence contradicts assigning the EPC to ${zoneLabel(c.zoneId)}`,
        {
          ...base,
          rulesFired: ["ANCHOR_EVIDENCE_CONFLICT"],
        },
      );
    const corroborated = rssiComparable && (components[0].available || anchor.available);
    const dominant =
      dominance !== null &&
      dominance >= p.evidence.strongDominance &&
      c.rawReadCount >= p.evidence.minReadsForDominance;
    if (!corroborated && !dominant)
      return review(
        "MULTI_ZONE_INSUFFICIENT_EVIDENCE",
        `Observed in ${names}; evidence for ${zoneLabel(c.zoneId)} is not corroborated by at least two evidence types or a strong read dominance`,
        { ...base, rulesFired: ["MULTI_ZONE_MIN_EVIDENCE_NOT_MET"] },
      );
    rules.push(corroborated ? "MULTI_ZONE_CORROBORATED" : "MULTI_ZONE_STRONG_DOMINANCE");

    if (s === null || s < p.bands.high)
      return review(
        "MULTI_ZONE_AMBIGUOUS",
        `Observed in ${names}; evidence score ${s ?? "n/a"} for ${zoneLabel(c.zoneId)} is below the acceptance threshold ${p.bands.high}`,
        {
          ...base,
          rulesFired: [...rules, "SCORE_BELOW_ACCEPTANCE_THRESHOLD"],
        },
      );
    return {
      classification: "ACCEPTED",
      assignedZoneId: c.zoneId,
      reasonCode: "MULTI_ZONE_RESOLVED",
      reasonDescription: `Observed in ${names}; evidence favours ${zoneLabel(c.zoneId)}`,
      confidenceType: "HEURISTIC_EVIDENCE_SCORE",
      score: s,
      rulesFired: [...rules, "SCORE_ABOVE_ACCEPTANCE_THRESHOLD"],
      components,
      dispositions: zones.map((z) =>
        z.zoneId === c.zoneId
          ? { zoneId: z.zoneId, disposition: "ACCEPTED", reasonCode: "MULTI_ZONE_RESOLVED" }
          : { zoneId: z.zoneId, disposition: "REJECTED_FROM_ZONE", reasonCode: "CROSS_READ_EXCLUDED" },
      ),
      candidateZoneId: c.zoneId,
    };
  }

  return agg.epcs.map((e) => {
    const d = e.zones.length === 1 ? decideSingle(e) : decideMulti(e);
    const evidence: EvidenceKind[] = ["ZONE_OBSERVATION"];
    if (readInfo) evidence.push("READ_COUNTS");
    if (e.zones.some((z) => z.firstSeen !== null)) evidence.push("TIMESTAMPS");
    if (e.zones.some((z) => z.rssi)) evidence.push("RSSI");
    if (d.components.some((c) => c.name === "anchor" && c.available)) evidence.push("ANCHORS");
    if (e.zones.some((z) => z.phaseAvailable)) evidence.push("PHASE_NOT_USED");
    const band =
      d.score === null
        ? null
        : d.score >= p.bands.high
          ? "HIGH"
          : d.score >= p.bands.medium
            ? "MEDIUM"
            : "LOW";
    return {
      epc: e.epc,
      epcRaw: e.epcRaw,
      observedZoneIds: e.zones.map((z) => z.zoneId),
      classification: d.classification,
      assignedZoneId: d.assignedZoneId,
      suggestedZoneId: d.candidateZoneId,
      confidenceScore: d.score,
      confidenceType: d.confidenceType,
      confidenceBand: band,
      reasonCode: d.reasonCode,
      reasonDescription: d.reasonDescription,
      recommendedAction: RECOMMENDED_ACTIONS[d.reasonCode] ?? "Verify the item's location physically.",
      evidenceAvailable: evidence,
      rulesFired: d.rulesFired,
      requiresManualReview: d.classification !== "ACCEPTED",
      zoneDispositions: d.dispositions,
      components: d.components,
    } satisfies ClassificationResult;
  });
}
