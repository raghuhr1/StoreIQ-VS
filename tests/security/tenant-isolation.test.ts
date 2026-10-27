import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { inject } from "vitest";
import { createJob, getJob, listJobs, retryJob } from "@/server/services/jobs";
import { epcTrace, listExceptions, listObserved, listResults, openOutput } from "@/server/services/results";
import { previewUpload, validateUpload, listUploads } from "@/server/services/uploads";
import { createZone, getStore, listStores, updateStore } from "@/server/services/stores";
import { listAnchors, registerAnchor } from "@/server/services/anchors";
import { createDataset, evaluateJob, listDatasets } from "@/server/services/calibration";
import { listAudit, listMembers, updateMember } from "@/server/services/users";
import { switchTenant } from "@/server/services/auth";
import { withTenant } from "@/server/db";
import { processJob, JobInputError } from "@/server/jobs/processor";
import { objectKey } from "@/server/storage";
import { LocalStorage } from "@/server/storage/local";
import { drainQueue, makeTenant, upload } from "../helpers/server";

type T = Awaited<ReturnType<typeof makeTenant>>;
let A: T;
let B: T;
let jobA: string;
let uploadA: string;
// Identical EPCs in both tenants (scenario 14).
const SAME_EPC = "E28011000000000000000ABC";

beforeAll(async () => {
  A = await makeTenant("ta");
  B = await makeTenant("tb");
  for (const t of [A, B]) {
    const u = await upload(
      t.admin,
      t.store.id,
      "f.csv",
      `EPC,Zone,RSSI\n${SAME_EPC},SF,-50\n${SAME_EPC},SF,-51\n`,
    );
    const { job } = await createJob(t.admin, {
      storeId: t.store.id,
      inputs: [{ uploadId: u.upload.id, mapping: { epc: "EPC", zone: "Zone", rssi: "RSSI" } }],
    });
    if (t === A) {
      jobA = job.id;
      uploadA = u.upload.id;
    }
  }
  await drainQueue();
});

describe("cross-tenant access through the service layer", () => {
  it("tenant B cannot read tenant A's jobs, results, uploads or stores", async () => {
    await expect(getJob(B.admin, jobA)).rejects.toThrow(/not found/i);
    await expect(listResults(B.admin, jobA, { limit: 10, offset: 0 })).rejects.toThrow(/not found/i);
    await expect(listExceptions(B.admin, jobA, { limit: 10, offset: 0 })).rejects.toThrow(/not found/i);
    await expect(listObserved(B.admin, jobA, { limit: 10, offset: 0 })).rejects.toThrow(/not found/i);
    await expect(epcTrace(B.admin, jobA, SAME_EPC)).rejects.toThrow(/not found/i);
    await expect(previewUpload(B.admin, uploadA)).rejects.toThrow(/not found/i);
    await expect(validateUpload(B.admin, uploadA, { mapping: { epc: "EPC", zone: "Zone" } })).rejects.toThrow(
      /not found/i,
    );
    await expect(getStore(B.admin, A.store.id)).rejects.toThrow(/not found/i);
    expect((await listStores(B.admin)).map((s) => s.id)).not.toContain(A.store.id);
    expect((await listJobs(B.admin, { limit: 100, offset: 0 })).items.map((j) => j.id)).not.toContain(jobA);
    expect((await listUploads(B.admin, { limit: 100, offset: 0 })).items.map((u) => u.id)).not.toContain(
      uploadA,
    );
  });

  it("tenant B cannot download tenant A's output files", async () => {
    await expect(openOutput(B.admin, jobA, "cleaned_sales_floor")).rejects.toThrow(/not found/i);
    const ok = await openOutput(A.admin, jobA, "cleaned_sales_floor");
    expect(ok.kind).toBe("stream");
  });

  it("tenant B cannot modify tenant A's stores, anchors or jobs", async () => {
    await expect(updateStore(B.admin, A.store.id, { name: "pwned" })).rejects.toThrow(/not found/i);
    await expect(createZone(B.admin, A.store.id, { code: "X", name: "X", type: "OTHER" })).rejects.toThrow(
      /not found/i,
    );
    await expect(
      registerAnchor(B.admin, A.store.id, { epc: "E28011000000000000000FFF", zoneId: A.sf.id }),
    ).rejects.toThrow(/not found/i);
    await expect(listAnchors(B.admin, A.store.id)).rejects.toThrow(/not found/i);
    await expect(retryJob(B.admin, jobA)).rejects.toThrow(/not found/i);
    // Using A's upload in B's job, or B's store with A's zone:
    await expect(
      createJob(B.admin, {
        storeId: B.store.id,
        inputs: [{ uploadId: uploadA, mapping: { epc: "EPC", zone: "Zone" } }],
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      upload(B.admin, B.store.id, "x.csv", "EPC\nE28011000000000000000001\n", { zoneId: A.sf.id }),
    ).rejects.toThrow(/not found/i);
    await expect(
      createDataset(
        B.admin,
        { storeId: A.store.id, name: "x", purpose: "GROUND_TRUTH" },
        "epc,actual_zone\nE28011000000000000000001,SF\n",
      ),
    ).rejects.toThrow(/not found/i);
    await expect(evaluateJob(B.admin, jobA, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /not found/i,
    );
    expect((await getStore(A.admin, A.store.id)).name).toBe("Store 1");
  });

  it("does not trust a tenant id that the user is not a member of", async () => {
    await expect(switchTenant(B.admin, A.admin.tenantId)).rejects.toThrow(/not a member/i);
    // A forged context (tenantId swapped) still only sees what RLS allows for that tenant id,
    // but service calls derive tenant from the session, never from request input.
    expect((await listDatasets(B.admin)).every((d) => d.tenantId === B.admin.tenantId)).toBe(true);
    expect(
      (await listAudit(B.admin, { limit: 100, offset: 0 })).items.every(
        (e) => e.tenantId === B.admin.tenantId,
      ),
    ).toBe(true);
    expect((await listMembers(B.admin)).map((m) => m.email)).not.toContain(A.email);
    await expect(updateMember(B.admin, A.admin.userId, { role: "VIEWER" })).rejects.toThrow(/not found/i);
  });

  it("keeps identical EPCs in different tenants separate", async () => {
    const ra = await withTenant(A.admin.tenantId, (tx) =>
      tx.classificationResult.findMany({ where: { epc: SAME_EPC } }),
    );
    const rb = await withTenant(B.admin.tenantId, (tx) =>
      tx.classificationResult.findMany({ where: { epc: SAME_EPC } }),
    );
    expect(ra).toHaveLength(1);
    expect(rb).toHaveLength(1);
    expect(ra[0].tenantId).toBe(A.admin.tenantId);
    expect(rb[0].jobId).not.toBe(ra[0].jobId);
  });
});

describe("database-enforced isolation (row-level security)", () => {
  it("returns nothing without a tenant context and blocks cross-tenant writes", async () => {
    const client = new pg.Client({ connectionString: inject("databaseUrl") });
    await client.connect();
    try {
      for (const table of [
        "Store",
        "ProcessingJob",
        "ClassificationResult",
        "Upload",
        "JobOutput",
        "AuditEvent",
        "RawObservation",
      ]) {
        const r = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
        expect(r.rows[0].n, table).toBe(0);
      }
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [B.admin.tenantId]);
      const unfiltered = await client.query(`SELECT "tenantId" FROM "ClassificationResult"`);
      expect(unfiltered.rows.every((r) => r.tenantId === B.admin.tenantId)).toBe(true);
      await expect(
        client
          .query(`UPDATE "Store" SET name = 'x' WHERE id = $1 RETURNING id`, [A.store.id])
          .then((r) => r.rowCount),
      ).resolves.toBe(0);
      await expect(
        client.query(
          `INSERT INTO "Store"(id,"tenantId",name,code,"updatedAt") VALUES (gen_random_uuid()::text,$1,'x','EVIL',now())`,
          [A.admin.tenantId],
        ),
      ).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK");
      // Audit log is append-only for the application role.
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [A.admin.tenantId]);
      await expect(client.query(`DELETE FROM "AuditEvent"`)).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });
});

describe("background job tenant validation", () => {
  it("refuses to process a queue item whose tenant does not own the job", async () => {
    const forged = {
      id: "q",
      jobId: jobA,
      tenantId: B.admin.tenantId,
      status: "RUNNING",
      attempts: 1,
      maxAttempts: 3,
    } as never;
    await expect(processJob(forged, "w")).rejects.toBeInstanceOf(JobInputError);
    // Tenant A's results are untouched.
    expect((await getJob(A.admin, jobA)).status).toBe("COMPLETED");
  });
});

describe("storage path safety", () => {
  it("rejects traversal in object keys and storage paths", async () => {
    expect(() => objectKey("tenants", "../other", "x")).toThrow();
    expect(() => objectKey("tenants", "a/b")).toThrow();
    const s = new LocalStorage(inject("storageDir"));
    await expect(s.getStream("../../etc/passwd")).rejects.toThrow(/escapes/);
    await expect(s.putBuffer("../x", Buffer.from("x"), "text/plain")).rejects.toThrow(/escapes/);
  });

  it("stores each tenant's objects under its own prefix", async () => {
    const outputs = await withTenant(A.admin.tenantId, (tx) =>
      tx.jobOutput.findMany({ where: { jobId: jobA } }),
    );
    expect(outputs.every((o) => o.storageKey.startsWith(`tenants/${A.admin.tenantId}/`))).toBe(true);
  });
});
