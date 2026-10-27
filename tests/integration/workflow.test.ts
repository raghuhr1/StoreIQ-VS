import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "csv-parse/sync";
import { generateScans, toScanCsv } from "../../scripts/lib/synthetic";
import { createJob, getJob, retryJob } from "@/server/services/jobs";
import {
  listExceptions,
  listObserved,
  listResults,
  listRowErrors,
  openOutput,
  epcTrace,
} from "@/server/services/results";
import { previewUpload, validateUpload } from "@/server/services/uploads";
import { dashboard } from "@/server/services/dashboard";
import { createDataset, evaluateJob } from "@/server/services/calibration";
import { listAudit } from "@/server/services/users";
import { withTenant } from "@/server/db";
import { drainQueue, makeTenant, streamToString, upload } from "../helpers/server";

type T = Awaited<ReturnType<typeof makeTenant>>;
const sepMapping = {
  mapping: { epc: "EPC", timestamp: "Timestamp", rssi: "Peak RSSI" },
  zoneValueMap: {},
  dateFormat: "AUTO" as const,
};
const gen = generateScans({ seed: 21, itemCount: 500 });
const sfCsv = toScanCsv(
  gen.rows.filter((r) => r.zone === "SALES_FLOOR"),
  { combined: false, eol: "\r\n" },
);
const brCsv = toScanCsv(
  gen.rows.filter((r) => r.zone === "BACK_ROOM"),
  { combined: false },
);

let t: T;
beforeAll(async () => {
  t = await makeTenant("wf");
});

async function runSeparate(tenant: T) {
  const a = await upload(tenant.admin, tenant.store.id, "sales_floor.csv", sfCsv, {
    zoneId: tenant.sf.id,
    sessionLabel: "SF-1",
  });
  const b = await upload(tenant.admin, tenant.store.id, "back_room.csv", brCsv, {
    zoneId: tenant.br.id,
    sessionLabel: "BR-1",
  });
  const { job } = await createJob(tenant.admin, {
    storeId: tenant.store.id,
    inputs: [
      { uploadId: a.upload.id, ...sepMapping },
      { uploadId: b.upload.id, ...sepMapping },
    ],
  });
  await drainQueue();
  return { job: await getJob(tenant.admin, job.id), a, b };
}

describe("separate Sales Floor and Back Room files", () => {
  it("uploads, previews, suggests a mapping and validates", async () => {
    const { upload: u } = await upload(t.admin, t.store.id, "preview.csv", sfCsv, { zoneId: t.sf.id });
    expect(u.lineEnding).toBe("CRLF");
    const p = await previewUpload(t.admin, u.id);
    expect(p.headers).toEqual(["EPC", "Timestamp", "Peak RSSI"]);
    expect(p.suggestion.mapping).toEqual({ epc: "EPC", timestamp: "Timestamp", rssi: "Peak RSSI" });
    expect(p.sampleRows.length).toBe(20);
    const v = await validateUpload(t.admin, u.id, sepMapping);
    expect(v.ok).toBe(true);
    expect(v.invalidRows).toBe(0);
    expect(v.totalRows).toBe(gen.rows.filter((r) => r.zone === "SALES_FLOOR").length);
    const bad = await validateUpload(t.admin, u.id, { ...sepMapping, mapping: { epc: "Nope" } });
    expect(bad.ok).toBe(false);
    expect(bad.mapping.errors[0]).toContain("Nope");
  });

  it("processes, stores traceable results and generates all outputs", async () => {
    const { job } = await runSeparate(t);
    expect(job.status).toBe("COMPLETED");
    expect(job.progress).toBe(100);
    expect(job.outputs.map((o) => o.filename).sort()).toEqual(
      [
        "cleaned_back_room.csv",
        "cleaned_sales_floor.csv",
        "exceptions.csv",
        "observed_inventory.csv",
        "processing_summary.csv",
      ].sort(),
    );
    expect(job.sessions.map((s) => s.externalId).sort()).toEqual(["BR-1", "SF-1"]);
    const unique = new Set(gen.rows.map((r) => r.epc)).size;
    expect(job.uniqueEpcCount).toBe(unique);

    const accepted = await listResults(t.admin, job.id, {
      classification: "ACCEPTED",
      zoneId: t.sf.id,
      limit: 1000,
      offset: 0,
    });
    const out = await openOutput(t.admin, job.id, "cleaned_sales_floor");
    expect(out.kind).toBe("stream");
    const rows = parse(await streamToString((out as { body: ReadableStream<Uint8Array> }).body), {
      columns: true,
    });
    expect(rows.length).toBe(accepted.total);

    const ex = await listExceptions(t.admin, job.id, { limit: 10, offset: 0 });
    expect(ex.total).toBeGreaterThan(0);
    const observed = await listObserved(t.admin, job.id, { limit: 5, offset: 0 });
    expect(observed.total).toBeGreaterThanOrEqual(unique);
    const trace = await epcTrace(t.admin, job.id, accepted.items[0].epc);
    expect(trace.observations.length).toBeGreaterThan(0);
    expect(trace.observations[0].rowNumber).toBeGreaterThan(1);

    const audits = await listAudit(t.admin, { action: "OUTPUT_DOWNLOADED", limit: 10, offset: 0 });
    expect(audits.total).toBeGreaterThan(0);
    const d = await dashboard(t.admin);
    expect(d.jobs.completed).toBeGreaterThan(0);
  });

  it("deduplicates repeated submissions and honours idempotency keys", async () => {
    const a = await upload(t.admin, t.store.id, "sf2.csv", "EPC\nE28011000000000000000001\n", {
      zoneId: t.sf.id,
    });
    expect(a.duplicateOf).toBeNull();
    const again = await upload(t.admin, t.store.id, "sf2-copy.csv", "EPC\nE28011000000000000000001\n", {
      zoneId: t.sf.id,
    });
    expect(again.duplicateOf?.id).toBe(a.upload.id);
    const body = { storeId: t.store.id, inputs: [{ uploadId: a.upload.id, mapping: { epc: "EPC" } }] };
    const j1 = await createJob(t.admin, body, "idem-key-0001");
    const j2 = await createJob(t.admin, body, "idem-key-0001");
    const j3 = await createJob(t.admin, body);
    expect(j2.job.id).toBe(j1.job.id);
    expect(j2.deduplicated).toBe(true);
    expect(j3.job.id).toBe(j1.job.id);
    await expect(
      createJob(t.admin, {
        ...body,
        inputs: [...body.inputs, { uploadId: again.upload.id, mapping: { epc: "EPC" } }],
      }),
    ).rejects.toThrow(/identical content/);
    await drainQueue();
  });

  it("retries a failed job without producing duplicate results", async () => {
    const tr = await makeTenant("retry");
    const { job } = await runSeparate(tr);
    const snapshot = async () =>
      withTenant(job.tenantId, async (tx) => ({
        results: await tx.classificationResult.count({ where: { jobId: job.id } }),
        raw: await tx.rawObservation.count({ where: { jobId: job.id } }),
        summaries: await tx.epcZoneSummary.count({ where: { jobId: job.id } }),
        outputs: (await tx.jobOutput.findMany({ where: { jobId: job.id }, orderBy: { kind: "asc" } })).map(
          (o) => [o.kind, o.rowCount],
        ),
      }));
    const before = await snapshot();
    // Simulate a crash after partial work: job marked failed with results already written.
    await withTenant(job.tenantId, (tx) =>
      tx.processingJob.update({ where: { id: job.id }, data: { status: "FAILED" } }),
    );
    await retryJob(tr.admin, job.id);
    await drainQueue();
    expect((await getJob(tr.admin, job.id)).status).toBe("COMPLETED");
    expect(await snapshot()).toEqual(before);
    const cleaned = await openOutput(tr.admin, job.id, "cleaned_back_room");
    const first = await streamToString((cleaned as { body: ReadableStream<Uint8Array> }).body);
    expect(first.split("\r\n")[0]).toBe(
      "job_id,store_id,epc,assigned_zone,confidence_score,confidence_type,classification_reason,processing_profile_version",
    );
  });
});

describe("combined multi-zone file", () => {
  it("processes a combined file with zone and session columns", async () => {
    const tc = await makeTenant("comb");
    const u = await upload(
      tc.admin,
      tc.store.id,
      "combined.csv",
      "﻿" + toScanCsv(gen.rows, { combined: true }),
    );
    expect(u.upload.hasBom).toBe(true);
    const mapping = {
      epc: "EPC",
      zone: "Zone",
      session: "Session ID",
      timestamp: "Timestamp",
      rssi: "Peak RSSI",
    };
    const { job } = await createJob(tc.admin, {
      storeId: tc.store.id,
      inputs: [{ uploadId: u.upload.id, mapping }],
    });
    await drainQueue();
    const done = await getJob(tc.admin, job.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.sessions.length).toBe(2);
  });

  it("reports malformed rows and missing data without failing the job", async () => {
    const tc = await makeTenant("mal");
    const good = Array.from(
      { length: 10 },
      (_, i) => `E280110000000000000001${String(i).padStart(2, "0")},SF,-50`,
    ).join("\n");
    const text = `EPC,Zone,RSSI\n${good}\n,SF,-50\nE28011000000000000000002,Attic,-50\nE28011000000000000000003,BR,abc\n"BROKEN,SF\n`;
    const u = await upload(tc.admin, tc.store.id, "bad.csv", text);
    const { job } = await createJob(tc.admin, {
      storeId: tc.store.id,
      inputs: [{ uploadId: u.upload.id, mapping: { epc: "EPC", zone: "Zone", rssi: "RSSI" } }],
    });
    await drainQueue();
    const done = await getJob(tc.admin, job.id);
    expect(done.status).toBe("COMPLETED");
    const errs = await listRowErrors(tc.admin, job.id, { limit: 50, offset: 0 });
    const codes = errs.items.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining(["MISSING_EPC", "UNKNOWN_ZONE", "INVALID_RSSI", "MALFORMED_ROW"]),
    );
  });

  it("fails the job when most rows are invalid (likely wrong mapping)", async () => {
    const tc = await makeTenant("ratio");
    const u = await upload(
      tc.admin,
      tc.store.id,
      "r.csv",
      "EPC,Zone\nE28011000000000000000001,SF\n,SF\nX,Attic\n",
    );
    const { job } = await createJob(tc.admin, {
      storeId: tc.store.id,
      inputs: [{ uploadId: u.upload.id, mapping: { epc: "EPC", zone: "Zone" } }],
    });
    await drainQueue();
    const failed = await getJob(tc.admin, job.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toMatch(/2 of 3 rows are invalid/);
  });

  it("fails with an actionable message when the mapping does not fit the file", async () => {
    const tc = await makeTenant("fail");
    const u = await upload(tc.admin, tc.store.id, "x.csv", "Tag,Where\nE28011000000000000000001,SF\n");
    const { job } = await createJob(tc.admin, {
      storeId: tc.store.id,
      inputs: [{ uploadId: u.upload.id, mapping: { epc: "EPC", zone: "Zone" } }],
    });
    await drainQueue();
    const failed = await getJob(tc.admin, job.id);
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toContain('"EPC"');
    await retryJob(tc.admin, job.id);
    await drainQueue();
    expect((await getJob(tc.admin, job.id)).status).toBe("FAILED");
  });
});

describe("ground-truth evaluation", () => {
  it("evaluates a job against a separately uploaded ground-truth dataset", async () => {
    const te = await makeTenant("eval");
    const { job } = await runSeparate(te);
    const labels =
      "epc,actual_zone,category\n" +
      gen.truth.map((x) => `${x.epc},${x.zone},${x.boundary ? "BOUNDARY" : "KNOWN_LOCATION"}`).join("\n");
    const gt = await createDataset(
      te.admin,
      { storeId: te.store.id, name: "GT", purpose: "GROUND_TRUTH", jobId: job.id },
      labels,
    );
    const ev = await evaluateJob(te.admin, job.id, gt.id);
    expect(ev.metrics.labeledCount).toBe(500);
    expect(ev.inSample).toBe(false);
    expect(ev.metrics.perZone.SALES_FLOOR.recall).not.toBeNull();
    const cal = await createDataset(
      te.admin,
      { storeId: te.store.id, name: "CAL", purpose: "CALIBRATION", jobId: job.id },
      labels,
    );
    await expect(evaluateJob(te.admin, job.id, cal.id)).rejects.toThrow(/reserved for tuning/);
  });
});
