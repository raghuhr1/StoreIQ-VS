import { describe, expect, it } from "vitest";
import { generateScans, toScanCsv } from "../../scripts/lib/synthetic";
import { createJob, getJob } from "@/server/services/jobs";
import { drainQueue, makeTenant, upload } from "../helpers/server";

const ROWS = Number(process.env.LARGE_FILE_ROWS ?? 120_000);

describe("large files (scenario 13)", () => {
  it(`processes ~${ROWS.toLocaleString()} per-read rows end to end through the database pipeline`, async () => {
    const t = await makeTenant("large");
    const { rows } = generateScans({ seed: 13, itemCount: Math.ceil(ROWS / 8.4) });
    const text = toScanCsv(rows, { combined: true });
    const started = performance.now();
    const u = await upload(t.admin, t.store.id, "large.csv", text);
    const mapping = {
      epc: "EPC",
      zone: "Zone",
      session: "Session ID",
      timestamp: "Timestamp",
      rssi: "Peak RSSI",
    };
    const { job } = await createJob(t.admin, {
      storeId: t.store.id,
      inputs: [{ uploadId: u.upload.id, mapping }],
    });
    await drainQueue();
    const seconds = (performance.now() - started) / 1000;
    const done = await getJob(t.admin, job.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.inputRowCount).toBe(rows.length);
    console.info(
      `[benchmark] ${rows.length} rows, ${(text.length / 2 ** 20).toFixed(1)} MB, ${done.uniqueEpcCount} EPCs: ${seconds.toFixed(1)} s end to end (${Math.round(rows.length / seconds)} rows/s)`,
    );
  }, 600_000);
});
