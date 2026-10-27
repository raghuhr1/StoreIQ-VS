import { describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import {
  buildExports,
  CLEANED_COLUMNS,
  evaluate,
  EXCEPTION_COLUMNS,
  OBSERVED_COLUMNS,
  SUMMARY_COLUMNS,
  suggestCalibration,
  type ZoneRef,
} from "@/engine";
import { generateScans, toScanCsv } from "../../scripts/lib/synthetic";
import { BR, fileCtx, runFiles, SF, ZONES } from "../helpers/engine";

const mapping = {
  epc: "EPC",
  zone: "Zone",
  session: "Session ID",
  timestamp: "Timestamp",
  rssi: "Peak RSSI",
};

async function synthetic(seed = 11, itemCount = 400) {
  const gen = generateScans({ seed, itemCount });
  const out = await runFiles([{ csv: toScanCsv(gen.rows, { combined: true }), ctx: fileCtx({ mapping }) }]);
  return { gen, out };
}

function exportsFor(out: Awaited<ReturnType<typeof runFiles>>, zones: ZoneRef[] = ZONES) {
  return buildExports({
    jobId: "job-1",
    storeId: "store-1",
    profileVersion: "Default@v1/svs-rules/1.0.0",
    zones,
    aggregation: out.aggregation,
    results: out.results,
    metrics: out.metrics,
    rowStats: out.rowStats,
    processingStatus: "COMPLETED",
    createdAt: Date.UTC(2026, 9, 1),
    completedAt: Date.UTC(2026, 9, 1, 0, 1),
  });
}

describe("exports", () => {
  it("generates all five required files with stable columns", async () => {
    const { out } = await synthetic();
    const files = exportsFor(out);
    expect(files.map((f) => f.filename)).toEqual([
      "observed_inventory.csv",
      "cleaned_sales_floor.csv",
      "cleaned_back_room.csv",
      "exceptions.csv",
      "processing_summary.csv",
    ]);
    const header = (name: string) =>
      files
        .find((f) => f.filename === name)!
        .content.split("\r\n")[0]
        .split(",");
    expect(header("observed_inventory.csv")).toEqual([...OBSERVED_COLUMNS]);
    expect(header("cleaned_sales_floor.csv")).toEqual([...CLEANED_COLUMNS]);
    expect(header("cleaned_back_room.csv")).toEqual([...CLEANED_COLUMNS]);
    expect(header("exceptions.csv")).toEqual([...EXCEPTION_COLUMNS]);
    expect(header("processing_summary.csv")).toEqual([...SUMMARY_COLUMNS]);
  });

  it("is consistent with the saved results", async () => {
    const { out } = await synthetic();
    const files = exportsFor(out);
    const rows = (name: string) =>
      parse(files.find((f) => f.filename === name)!.content, { columns: true }) as Record<string, string>[];
    const sf = rows("cleaned_sales_floor.csv");
    const br = rows("cleaned_back_room.csv");
    expect(sf.length).toBe(out.metrics.acceptedByZone.SALES_FLOOR);
    expect(br.length).toBe(out.metrics.acceptedByZone.BACK_ROOM);
    // An EPC is never in both cleaned files.
    const sfSet = new Set(sf.map((r) => r.epc));
    expect(br.some((r) => sfSet.has(r.epc))).toBe(false);
    const observed = rows("observed_inventory.csv");
    expect(observed.length).toBe(out.aggregation.epcs.reduce((n, e) => n + e.zones.length, 0));
    const summary = rows("processing_summary.csv")[0];
    expect(Number(summary.unique_epc_count)).toBe(out.results.length);
    expect(summary.completed_at).toBe("2026-10-01T00:01:00.000Z");
    const ex = rows("exceptions.csv");
    expect(ex.filter((r) => r.classification === "NEEDS_REVIEW").length).toBe(out.metrics.reviewCount);
    expect(ex.filter((r) => r.classification === "REJECTED_FROM_ZONE").length).toBe(
      out.metrics.rejectedFromZoneCount + out.metrics.rejectedPrimaryCount,
    );
  });

  it("leaves optional fields empty when absent from the input", async () => {
    const out = await runFiles([
      {
        csv: "EPC,Zone\nE28011000000000000000001,SF\n",
        ctx: fileCtx({ mapping: { epc: "EPC", zone: "Zone" } }),
      },
    ]);
    const obs = exportsFor(out)[0].content.split("\r\n")[1].split(",");
    expect(obs.slice(6, 9)).toEqual(["", "", ""]); // first_seen, last_seen, median_rssi
    const cleaned = exportsFor(out)[1].content.split("\r\n")[1].split(",");
    expect(cleaned[4]).toBe(""); // no fabricated confidence score
    expect(cleaned[5]).toBe("RULE_BASED_NO_SCORE");
  });

  it("protects exported text against formula injection", async () => {
    const out = await runFiles([
      {
        csv: 'EPC,Zone,Session\nE28011000000000000000001,SF,"=HYPERLINK(""http://x"")"\n',
        ctx: fileCtx({ mapping: { epc: "EPC", zone: "Zone", session: "Session" } }),
      },
    ]);
    const line = exportsFor(out)[0].content.split("\r\n")[1];
    expect(line).toContain("'=HYPERLINK");
  });

  it("adds a cleaned file for each additional zone type", async () => {
    const RCV: ZoneRef = {
      id: "z-rcv",
      code: "RECEIVING",
      name: "Receiving",
      type: "RECEIVING",
      aliases: [],
      sortOrder: 2,
    };
    const out = await runFiles([
      {
        csv: "EPC,Zone\nE28011000000000000000001,SF\n",
        ctx: fileCtx({ mapping: { epc: "EPC", zone: "Zone" } }),
      },
    ]);
    expect(exportsFor(out, [...ZONES, RCV]).map((f) => f.filename)).toContain("cleaned_zone_receiving.csv");
  });

  it("produces byte-identical outputs for identical inputs", async () => {
    const a = exportsFor((await synthetic(5, 200)).out);
    const b = exportsFor((await synthetic(5, 200)).out);
    expect(a.map((f) => f.content)).toEqual(b.map((f) => f.content));
  });
});

describe("operational metrics", () => {
  it("never reports accuracy without labels and computes overlap/review rates", async () => {
    const { out } = await synthetic();
    const m = out.metrics;
    expect(m).not.toHaveProperty("recall");
    expect(m.uniqueEpcCount).toBe(out.results.length);
    expect(m.multiZoneOverlapRate).toBeCloseTo(m.multiZoneEpcCount / m.uniqueEpcCount, 3);
    expect(m.acceptedCount + m.reviewCount + m.rejectedPrimaryCount).toBe(m.uniqueEpcCount);
  });
});

describe("ground-truth evaluation (synthetic — validates logic, not real-world accuracy)", () => {
  it("computes recall, false acceptance and a confusion matrix; raw baseline has cross-zone errors", async () => {
    const { gen, out } = await synthetic(11, 600);
    const labels = gen.truth.map((t) => ({
      epc: t.epc,
      actualZoneId: t.zone === "SALES_FLOOR" ? SF.id : BR.id,
    }));
    const ev = evaluate(out.results, labels, ZONES);
    expect(ev.labeledCount).toBe(600);
    const sf = ev.perZone.SALES_FLOOR;
    expect(sf.recall).not.toBeNull();
    expect(sf.falseAcceptanceRate!).toBeLessThan(sf.rawFalseAcceptanceRate!);
    const total = ev.confusion.counts.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(600);
  });

  it("returns null metrics when no labels are given", () => {
    const ev = evaluate([], [], ZONES);
    expect(ev.overall.recall).toBeNull();
    expect(ev.perZone.SALES_FLOOR.falseAcceptanceRate).toBeNull();
  });

  it("handles hand-computed cases exactly", () => {
    const mk = (
      epc: string,
      classification: "ACCEPTED" | "NEEDS_REVIEW",
      zone: string | null,
      observed: string[],
    ) => ({
      epc,
      epcRaw: epc,
      observedZoneIds: observed,
      classification,
      assignedZoneId: zone,
      suggestedZoneId: zone,
      confidenceScore: 90,
      confidenceType: "HEURISTIC_EVIDENCE_SCORE" as const,
      confidenceBand: "HIGH" as const,
      reasonCode: "X",
      reasonDescription: "",
      recommendedAction: "",
      evidenceAvailable: [],
      rulesFired: [],
      requiresManualReview: false,
      zoneDispositions: [],
      components: [],
    });
    const results = [
      mk("A", "ACCEPTED", SF.id, [SF.id]),
      mk("B", "ACCEPTED", SF.id, [SF.id, BR.id]),
      mk("C", "NEEDS_REVIEW", null, [SF.id, BR.id]),
    ];
    const labels = [
      { epc: "A", actualZoneId: SF.id },
      { epc: "B", actualZoneId: BR.id },
      { epc: "C", actualZoneId: SF.id },
      { epc: "D", actualZoneId: SF.id }, // never observed
    ];
    const ev = evaluate(results, labels, ZONES);
    expect(ev.perZone.SALES_FLOOR.recall).toBe(0.3333); // A of {A, C, D}
    expect(ev.perZone.SALES_FLOOR.falseAcceptanceRate).toBe(0.5); // B accepted wrongly
    expect(ev.perZone.SALES_FLOOR.rawRecall).toBe(0.6667); // A, C observed in SF
    expect(ev.labeledNotObservedCount).toBe(1);
  });
});

describe("calibration suggestions", () => {
  it("requires enough labeled samples and uses labels, not predictions", async () => {
    const { gen, out } = await synthetic(3, 120);
    const few = suggestCalibration(
      out.aggregation,
      gen.truth
        .slice(0, 10)
        .map((t) => ({ epc: t.epc, actualZoneId: t.zone === "SALES_FLOOR" ? SF.id : BR.id })),
      ZONES,
    );
    expect(few.zones.every((z) => z.suggestedWeakRssiThreshold === null)).toBe(true);
    const big = await synthetic(3, 2000);
    const s = suggestCalibration(
      big.out.aggregation,
      big.gen.truth.map((t) => ({ epc: t.epc, actualZoneId: t.zone === "SALES_FLOOR" ? SF.id : BR.id })),
      ZONES,
    );
    const sf = s.zones.find((z) => z.zoneCode === "SALES_FLOOR")!;
    expect(sf.genuineCount).toBeGreaterThan(30);
    expect(sf.crossReadCount).toBeGreaterThan(30);
    expect(sf.suggestedWeakRssiThreshold).not.toBeNull();
  });
});
