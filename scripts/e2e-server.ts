/**
 * Test harness for Playwright: fresh embedded PostgreSQL, migrations, an E2E
 * tenant with one store, then `next start` and the worker. Requires a prior
 * `npm run build`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEmbeddedDb } from "./lib/embedded-db";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "svs-e2e-"));
const children: ChildProcess[] = [];

async function main() {
  const db = await startEmbeddedDb({
    dir: path.join(tmp, "pg"),
    port: 56000 + Math.floor(Math.random() * 1000),
    dbName: "svs_e2e",
    ownerPassword: "e2e-owner",
    appPassword: "e2e-app",
    persistent: false,
    quiet: true,
  });
  const env = {
    ...process.env,
    NODE_ENV: "production" as const,
    DATABASE_URL: db.appUrl,
    MIGRATION_DATABASE_URL: db.ownerUrl,
    APP_URL: `http://localhost:${PORT}`,
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: path.join(tmp, "storage"),
    WORKER_POLL_INTERVAL_MS: "300",
    LOG_LEVEL: "warn",
    PORT: String(PORT),
  };
  Object.assign(process.env, env);
  const { createTenantWithAdmin } = await import("@/server/services/tenants");
  const { login } = await import("@/server/services/auth");
  const { authFromToken } = await import("@/server/auth/context");
  const { createStore } = await import("@/server/services/stores");
  await createTenantWithAdmin({
    tenantName: "E2E Retail",
    slug: "e2e",
    adminEmail: "e2e-admin@example.test",
    adminName: "E2E Admin",
    adminPassword: "e2e-password-123456",
  });
  const s = await login(
    { email: "e2e-admin@example.test", password: "e2e-password-123456" },
    { ip: "127.0.0.1", requestId: "seed" },
  );
  await createStore((await authFromToken(s.token, { requestId: "seed", ip: null }))!, {
    name: "E2E Store",
    code: "E2E1",
    timeZone: "UTC",
  });

  const nextBin = path.resolve("node_modules/next/dist/bin/next");
  children.push(spawn(process.execPath, [nextBin, "start", "-p", String(PORT)], { env, stdio: "inherit" }));
  children.push(
    spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "src/worker/index.ts"], {
      env,
      stdio: "inherit",
    }),
  );
  const stop = async () => {
    for (const c of children) c.kill("SIGTERM");
    await db.stop().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  for (const c of children) c.kill("SIGTERM");
  process.exit(1);
});
