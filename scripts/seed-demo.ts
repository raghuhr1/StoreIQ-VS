/**
 * Seed a clearly labelled SAMPLE DATA tenant for demonstrations.
 * All scans are synthetic (scripts/lib/synthetic.ts) and are NOT real RFID data
 * or evidence of real-world accuracy.
 *
 *   ADMIN_PASSWORD='...' npm run seed:demo
 */
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { authFromToken } from "@/server/auth/context";
import { disconnectDb } from "@/server/db";
import { runOnce } from "@/server/jobs/worker-loop";
import { login } from "@/server/services/auth";
import { createJob } from "@/server/services/jobs";
import { createStore } from "@/server/services/stores";
import { createTenantWithAdmin } from "@/server/services/tenants";
import { ingestUpload } from "@/server/services/uploads";
import { generateScans, toScanCsv } from "./lib/synthetic";

try {
  process.loadEnvFile();
} catch {
  /* optional */
}

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 12)
    throw new Error("Set ADMIN_PASSWORD (>= 12 characters) for the demo admin");
  const email = process.env.DEMO_EMAIL ?? "demo-admin@example.com";
  const slug = `sample-demo-${randomUUID().slice(0, 6)}`;
  await createTenantWithAdmin({
    tenantName: "Demo Retail (SAMPLE DATA)",
    slug,
    adminEmail: email,
    adminName: "Demo Admin",
    adminPassword: password,
  });
  const s = await login({ email, password }, { ip: "127.0.0.1", requestId: randomUUID() });
  const ctx = (await authFromToken(s.token, { requestId: randomUUID(), ip: "127.0.0.1" }))!;
  const store = await createStore(ctx, {
    name: "Sample Store (synthetic data)",
    code: "SAMPLE-001",
    timeZone: "UTC",
  });
  const sf = store.zones.find((z) => z.code === "SALES_FLOOR")!;
  const br = store.zones.find((z) => z.code === "BACK_ROOM")!;
  const { rows } = generateScans({ seed: 2026, itemCount: 2000 });
  const up = (name: string, zoneId: string, text: string, sessionLabel: string) =>
    ingestUpload(ctx, {
      storeId: store.id,
      filename: name,
      zoneId,
      sessionLabel,
      body: Readable.from([Buffer.from(text)]),
    });
  const a = await up(
    "SAMPLE_sales_floor.csv",
    sf.id,
    toScanCsv(
      rows.filter((r) => r.zone === "SALES_FLOOR"),
      { combined: false },
    ),
    "SAMPLE-SF",
  );
  const b = await up(
    "SAMPLE_back_room.csv",
    br.id,
    toScanCsv(
      rows.filter((r) => r.zone === "BACK_ROOM"),
      { combined: false },
    ),
    "SAMPLE-BR",
  );
  const mapping = { epc: "EPC", timestamp: "Timestamp", rssi: "Peak RSSI" };
  const { job } = await createJob(ctx, {
    storeId: store.id,
    inputs: [
      { uploadId: a.upload.id, mapping },
      { uploadId: b.upload.id, mapping },
    ],
  });
  while (await runOnce("seed")) {
    /* drain */
  }
  console.log(`SAMPLE DATA tenant "${slug}" seeded. Sign in as ${email}. Job: ${job.id}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
