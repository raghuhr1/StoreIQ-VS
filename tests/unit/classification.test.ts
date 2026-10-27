import { describe, expect, it } from "vitest";
import { epcFor, generateScans, toScanCsv } from "../../scripts/lib/synthetic";
import { BR, csv, fileCtx, runFiles, SF } from "../helpers/engine";

const E = (i: number) => epcFor("E28011", i);
const byEpc = <T extends { epc: string }>(rs: T[]) => new Map(rs.map((r) => [r.epc, r]));
const sfFile = (text: string, over = {}) => ({
  csv: text,
  ctx: fileCtx({
    uploadId: "u-sf",
    fixedZoneId: SF.id,
    sessionLabel: "SF-1",
    mapping: { epc: "EPC", timestamp: "Timestamp", rssi: "RSSI", readCount: "Reads" },
    ...over,
  }),
});
const brFile = (text: string, over = {}) => ({
  csv: text,
  ctx: fileCtx({
    uploadId: "u-br",
    fixedZoneId: BR.id,
    sessionLabel: "BR-1",
    mapping: { epc: "EPC", timestamp: "Timestamp", rssi: "RSSI", readCount: "Reads" },
    ...over,
  }),
});

function perRead(epc: string, n: number, rssi: number, startIso: string, stepSec = 6) {
  const t0 = Date.parse(startIso);
  return Array.from({ length: n }, (_, k) => [
    epc,
    new Date(t0 + k * stepSec * 1000).toISOString(),
    rssi + (k % 3) - 1,
  ]);
}
const H = ["EPC", "Timestamp", "RSSI"];

describe("scenario 1: all EPCs observed in only one zone", () => {
  it("accepts well-observed single-zone EPCs into their zone", async () => {
    const out = await runFiles([
      sfFile(
        csv(H, [
          ...perRead(E(1), 6, -50, "2026-10-01T09:00:00Z"),
          ...perRead(E(2), 6, -48, "2026-10-01T09:01:00Z"),
        ]),
      ),
      brFile(csv(H, perRead(E(3), 6, -51, "2026-10-01T09:40:00Z"))),
    ]);
    const r = byEpc(out.results);
    expect(r.get(E(1))).toMatchObject({
      classification: "ACCEPTED",
      assignedZoneId: SF.id,
      reasonCode: "SINGLE_ZONE_STRONG_EVIDENCE",
      confidenceType: "HEURISTIC_EVIDENCE_SCORE",
    });
    expect(r.get(E(3))).toMatchObject({ classification: "ACCEPTED", assignedZoneId: BR.id });
    expect(out.metrics.multiZoneEpcCount).toBe(0);
  });
});

describe("scenario 2/3: EPCs observed in both zones with strong vs weak relative evidence", () => {
  it("resolves a strong-vs-weak cross-read and excludes it from the weak zone", async () => {
    const out = await runFiles([
      sfFile(csv(H, perRead(E(1), 8, -48, "2026-10-01T09:00:00Z"))),
      brFile(csv(H, perRead(E(1), 1, -74, "2026-10-01T09:40:00Z"))),
    ]);
    const r = out.results[0];
    expect(r).toMatchObject({
      classification: "ACCEPTED",
      assignedZoneId: SF.id,
      reasonCode: "MULTI_ZONE_RESOLVED",
    });
    expect(r.zoneDispositions).toEqual([
      { zoneId: SF.id, disposition: "ACCEPTED", reasonCode: "MULTI_ZONE_RESOLVED" },
      { zoneId: BR.id, disposition: "REJECTED_FROM_ZONE", reasonCode: "CROSS_READ_EXCLUDED" },
    ]);
    expect(r.confidenceScore).toBeGreaterThanOrEqual(85);
    expect(out.metrics.rejectedFromZoneCount).toBe(1);
  });

  it("sends evenly matched multi-zone evidence to review", async () => {
    const out = await runFiles([
      sfFile(csv(H, perRead(E(1), 4, -60, "2026-10-01T09:00:00Z"))),
      brFile(csv(H, perRead(E(1), 3, -59, "2026-10-01T09:40:00Z"))),
    ]);
    expect(out.results[0].classification).toBe("NEEDS_REVIEW");
    expect(out.results[0].assignedZoneId).toBeNull();
  });

  it("flags RSSI that contradicts read counts", async () => {
    const out = await runFiles([
      sfFile(csv(["EPC", "RSSI", "Reads"], [[E(1), -50, 1]]), {
        mapping: { epc: "EPC", rssi: "RSSI", readCount: "Reads" },
      }),
      brFile(csv(["EPC", "RSSI", "Reads"], [[E(1), -62, 20]]), {
        mapping: { epc: "EPC", rssi: "RSSI", readCount: "Reads" },
      }),
    ]);
    expect(out.results[0].reasonCode).toBe("CONFLICTING_SIGNAL_EVIDENCE");
  });
});

describe("scenario 4: missing RSSI values", () => {
  it("uses read dominance only when strong, and never fabricates RSSI", async () => {
    const H2 = ["EPC", "Timestamp"];
    const out = await runFiles([
      sfFile(
        csv(
          H2,
          [
            ...perRead(E(1), 20, 0, "2026-10-01T09:00:00Z"),
            ...perRead(E(4), 12, 0, "2026-10-01T09:05:00Z"),
          ].map((r) => r.slice(0, 2)),
        ),
      ),
      brFile(
        csv(H2, [
          [E(1), "2026-10-01T09:40:00Z"],
          [E(4), "2026-10-01T09:40:30Z"],
          ...perRead(E(2), 3, 0, "2026-10-01T09:41:00Z").map((r) => r.slice(0, 2)),
        ]),
      ),
    ]);
    const r = byEpc(out.results);
    expect(r.get(E(1))).toMatchObject({ classification: "ACCEPTED", assignedZoneId: SF.id });
    expect(r.get(E(1))!.evidenceAvailable).not.toContain("RSSI");
    // 12 vs 1 reads without RSSI scores just below the acceptance band: review, not a guess.
    expect(r.get(E(4))).toMatchObject({
      classification: "NEEDS_REVIEW",
      reasonCode: "MULTI_ZONE_AMBIGUOUS",
      suggestedZoneId: SF.id,
    });
    expect(r.get(E(2))!.classification).toBe("ACCEPTED");
    expect(out.aggregation.warnings.map((w) => w.code)).toContain("NO_RSSI");
    expect(out.aggregation.epcs.every((e) => e.zones.every((z) => z.rssi === null))).toBe(true);
  });
});

describe("scenario 5: missing timestamps", () => {
  it("reports that temporal inference is unavailable and leaves first/last seen empty", async () => {
    const out = await runFiles([
      sfFile(
        csv(
          ["EPC", "RSSI"],
          [
            [E(1), -50],
            [E(1), -51],
            [E(1), -49],
            [E(1), -50],
            [E(1), -52],
          ],
        ),
      ),
    ]);
    expect(out.aggregation.warnings.map((w) => w.code)).toContain("NO_TIMESTAMPS");
    const z = out.aggregation.epcs[0].zones[0];
    expect(z.firstSeen).toBeNull();
    expect(z.windowCount).toBeNull();
    expect(out.results[0].classification).toBe("ACCEPTED");
    expect(out.aggregation.sessionPairs.every((p) => p.relation === "UNKNOWN_TIMING")).toBe(true);
  });
});

describe("scenario 6: repeated observations", () => {
  it("counts unique EPCs once, sums reads, and collapses exact duplicates when timestamps exist", async () => {
    const rows = perRead(E(1), 5, -50, "2026-10-01T09:00:00Z");
    const out = await runFiles([sfFile(csv(H, [...rows, rows[0], rows[1]]))]);
    expect(out.metrics.uniqueEpcCount).toBe(1);
    expect(out.aggregation.stats.duplicateObservationCount).toBe(2);
    expect(out.aggregation.epcs[0].zones[0].rawReadCount).toBe(5);
    expect(out.rowStats.validRowCount).toBe(7);
  });

  it("counts identical rows as reads when the export has no timestamps or read counts (AUTO)", async () => {
    const rows = [
      [E(1), -50],
      [E(1), -50],
      [E(1), -50],
    ];
    const out = await runFiles([
      sfFile(csv(["EPC", "RSSI"], rows), { mapping: { epc: "EPC", rssi: "RSSI" } }),
    ]);
    expect(out.aggregation.epcs[0].zones[0].rawReadCount).toBe(3);
  });

  it("treats a missing read count as at least one read, never zero", async () => {
    const out = await runFiles([
      sfFile(
        csv(
          ["EPC", "Reads"],
          [
            [E(1), 4],
            [E(1), ""],
          ],
        ),
        { mapping: { epc: "EPC", readCount: "Reads" } },
      ),
    ]);
    const z = out.aggregation.epcs[0].zones[0];
    expect(z.rawReadCount).toBe(5);
    expect(z.readCountComplete).toBe(false);
  });
});

describe("scenario 7: incorrect zone labels", () => {
  it("flags rows whose zone label contradicts the file zone", async () => {
    const out = await runFiles([
      sfFile(
        csv(
          ["EPC", "Zone", "RSSI"],
          [
            [E(1), "Sales Floor", -50],
            [E(2), "Back Room", -50],
          ],
        ),
        { mapping: { epc: "EPC", zone: "Zone", rssi: "RSSI" } },
      ),
    ]);
    const r = byEpc(out.results);
    expect(r.get(E(2))!.reasonCode).toBe("CONFLICTING_ZONE_LABELS");
    expect(r.get(E(1))!.classification).toBe("ACCEPTED");
    expect(out.rowStats.issueCounts.ZONE_LABEL_CONFLICT).toBe(1);
  });

  it("rejects rows with unknown zones in combined files with an actionable error", async () => {
    const out = await runFiles([
      {
        csv: csv(
          ["EPC", "Zone"],
          [
            [E(1), "SF"],
            [E(2), "Mezzanine"],
          ],
        ),
        ctx: fileCtx({ mapping: { epc: "EPC", zone: "Zone" } }),
      },
    ]);
    expect(out.rowStats.invalidRowCount).toBe(1);
    expect(out.issues.find((i) => i.code === "UNKNOWN_ZONE")?.message).toContain("Mezzanine");
  });
});

describe("scenario 8/9: anchors missing or misleading", () => {
  const anchors = [
    { epc: "A0000000000000000000000B", zoneId: BR.id },
    { epc: "A0000000000000000000000S", zoneId: SF.id },
  ].map((a) => ({ ...a, epc: a.epc.replace(/[BS]$/, (c) => (c === "B" ? "1" : "2")) }));

  it("does not treat missing anchors as evidence", async () => {
    const out = await runFiles(
      [sfFile(csv(H, perRead(E(1), 6, -50, "2026-10-01T09:00:00Z")))],
      {},
      { anchors },
    );
    expect(out.results[0].classification).toBe("ACCEPTED");
    expect(out.results[0].evidenceAvailable).not.toContain("ANCHORS");
    expect(out.aggregation.warnings.map((w) => w.code)).toContain("ANCHORS_NOT_OBSERVED");
  });

  it("excludes anchors from inventory and sends EPCs weaker than a cross-zone anchor to review", async () => {
    const rows = [
      ...perRead(E(1), 6, -75, "2026-10-01T09:00:00Z"),
      ...perRead(anchors[0].epc, 4, -60, "2026-10-01T09:00:30Z"), // Back Room anchor heard strongly from the Sales Floor
    ];
    const out = await runFiles([sfFile(csv(H, rows))], {}, { anchors });
    expect(out.results.map((r) => r.epc)).toEqual([E(1)]);
    expect(out.aggregation.anchorEpcs).toEqual([anchors[0].epc]);
    expect(out.results[0]).toMatchObject({
      classification: "NEEDS_REVIEW",
      reasonCode: "ANCHOR_EVIDENCE_CONFLICT",
    });
  });

  it("does not let a single misleading anchor override strong own-zone evidence", async () => {
    const rows = [
      ...perRead(E(1), 8, -45, "2026-10-01T09:00:00Z"),
      ...perRead(anchors[0].epc, 2, -70, "2026-10-01T09:00:30Z"),
    ];
    const out = await runFiles([sfFile(csv(H, rows))], {}, { anchors });
    expect(out.results[0].classification).toBe("ACCEPTED");
  });
});

describe("scenario 10: very sparse scans", () => {
  it("sends single-read EPCs to review when read evidence exists", async () => {
    const out = await runFiles([
      sfFile(csv(H, [...perRead(E(1), 6, -50, "2026-10-01T09:00:00Z"), [E(2), "2026-10-01T09:05:00Z", -60]])),
    ]);
    const r = byEpc(out.results);
    expect(r.get(E(2))).toMatchObject({ classification: "NEEDS_REVIEW", reasonCode: "SPARSE_OBSERVATION" });
    expect(out.aggregation.epcs.find((e) => e.epc === E(2))!.zones[0].dataQualityStatus).toBe("SPARSE");
  });
});

describe("scenario 11: conflicting / non-contemporaneous sessions", () => {
  it("does not compare scans far apart in time", async () => {
    const out = await runFiles([
      sfFile(csv(H, perRead(E(1), 8, -48, "2026-10-01T09:00:00Z"))),
      brFile(csv(H, perRead(E(1), 1, -75, "2026-10-04T09:00:00Z"))),
    ]);
    expect(out.results[0].reasonCode).toBe("SESSIONS_NOT_CONTEMPORANEOUS");
    expect(out.aggregation.warnings.map((w) => w.code)).toContain("SESSIONS_FAR_APART");
  });

  it("flags possible movement when strongly observed in both zones in sequential scans", async () => {
    const out = await runFiles([
      sfFile(csv(H, perRead(E(1), 8, -48, "2026-10-01T09:00:00Z", 20))),
      brFile(csv(H, perRead(E(1), 6, -55, "2026-10-01T09:40:00Z", 20))),
    ]);
    expect(out.results[0].reasonCode).toBe("POSSIBLE_MOVEMENT");
  });
});

describe("EPC + zone only input", () => {
  it("accepts single-zone EPCs by rule without a score and reviews multi-zone EPCs", async () => {
    const m = { mapping: { epc: "EPC" } };
    const out = await runFiles([
      sfFile(csv(["EPC"], [[E(1)], [E(2)]]), m),
      brFile(csv(["EPC"], [[E(2)], [E(3)]]), m),
    ]);
    const r = byEpc(out.results);
    expect(r.get(E(1))).toMatchObject({
      classification: "ACCEPTED",
      confidenceScore: null,
      confidenceType: "RULE_BASED_NO_SCORE",
      reasonCode: "SINGLE_ZONE_RULE_ONLY",
    });
    expect(r.get(E(2))).toMatchObject({
      classification: "NEEDS_REVIEW",
      reasonCode: "MULTI_ZONE_NO_SIGNAL_EVIDENCE",
      confidenceScore: null,
    });
  });

  it("can be configured to review instead of rule-accepting", async () => {
    const out = await runFiles([sfFile(csv(["EPC"], [[E(1)]]), { mapping: { epc: "EPC" } })], {
      rules: { acceptSingleZoneWithoutSignal: false },
    });
    expect(out.results[0].classification).toBe("NEEDS_REVIEW");
  });
});

describe("malformed EPCs", () => {
  it("keeps malformed EPCs for review by default and rejects rows when configured", async () => {
    const text = csv(
      ["EPC", "RSSI"],
      [
        ["NOT-A-HEX-EPC!", -50],
        [E(1), -50],
      ],
    );
    const flagged = await runFiles([sfFile(text, { mapping: { epc: "EPC", rssi: "RSSI" } })]);
    expect(flagged.results.find((r) => r.reasonCode === "MALFORMED_EPC")?.classification).toBe(
      "NEEDS_REVIEW",
    );
    const rejected = await runFiles([sfFile(text, { mapping: { epc: "EPC", rssi: "RSSI" } })], {
      epc: { malformedPolicy: "REJECT" },
    });
    expect(rejected.results).toHaveLength(1);
    expect(rejected.rowStats.invalidRowCount).toBe(1);
  });
});

describe("calibrated weak-signal exclusion", () => {
  it("only excludes single-zone EPCs when a calibrated threshold and the rule are configured", async () => {
    const rows = perRead(E(1), 6, -85, "2026-10-01T09:00:00Z");
    const plain = await runFiles([sfFile(csv(H, rows))]);
    expect(plain.results[0].classification).toBe("ACCEPTED");
    const calibrated = await runFiles([sfFile(csv(H, rows))], {
      rules: { rejectBelowCalibratedThreshold: true },
      zoneCalibration: { SALES_FLOOR: { weakRssiThreshold: -65 } },
    });
    expect(calibrated.results[0]).toMatchObject({
      classification: "REJECTED_FROM_ZONE",
      reasonCode: "WEAK_SIGNAL_BELOW_CALIBRATED_THRESHOLD",
      requiresManualReview: true,
    });
  });
});

describe("combined multi-zone file and determinism", () => {
  it("gives identical results for separate and combined files of the same scan, and is deterministic", async () => {
    const { rows } = generateScans({ seed: 7, itemCount: 300 });
    const combined = toScanCsv(rows, { combined: true });
    const mapping = {
      epc: "EPC",
      zone: "Zone",
      session: "Session ID",
      timestamp: "Timestamp",
      rssi: "Peak RSSI",
    };
    const a = await runFiles([{ csv: combined, ctx: fileCtx({ mapping }) }]);
    const b = await runFiles([{ csv: combined, ctx: fileCtx({ mapping }) }]);
    expect(JSON.stringify(a.results)).toBe(JSON.stringify(b.results));

    const sepMap = { epc: "EPC", timestamp: "Timestamp", rssi: "Peak RSSI" };
    const sf = toScanCsv(
      rows.filter((r) => r.zone === "SALES_FLOOR"),
      { combined: false, eol: "\r\n" },
    );
    const br = toScanCsv(
      rows.filter((r) => r.zone === "BACK_ROOM"),
      { combined: false },
    );
    const c = await runFiles([sfFile(sf, { mapping: sepMap }), brFile(br, { mapping: sepMap })]);
    const strip = (rs: typeof a.results) =>
      rs.map((r) => [r.epc, r.classification, r.assignedZoneId, r.confidenceScore, r.reasonCode]);
    expect(strip(c.results)).toEqual(strip(a.results));
  });
});
