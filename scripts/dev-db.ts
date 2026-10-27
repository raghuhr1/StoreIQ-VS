/**
 * Starts a persistent local PostgreSQL for development (no Docker needed).
 *   npm run db:dev
 * Reads ownership/app passwords from .env (MIGRATION_DATABASE_URL / APP_DB_PASSWORD).
 */
import path from "node:path";
import { startEmbeddedDb } from "./lib/embedded-db";

try {
  process.loadEnvFile();
} catch {
  /* optional */
}

const ownerUrl = new URL(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:change-me-owner@localhost:54329/vshield",
);
const appPassword = process.env.APP_DB_PASSWORD ?? "change-me-app";

async function main() {
  const db = await startEmbeddedDb({
    dir: path.resolve(".data/pg"),
    port: Number(ownerUrl.port || 54329),
    dbName: ownerUrl.pathname.slice(1) || "vshield",
    ownerPassword: decodeURIComponent(ownerUrl.password),
    appPassword,
    persistent: true,
  });
  console.log(`PostgreSQL ready on port ${ownerUrl.port}. Migrations applied. Press Ctrl+C to stop.`);
  const shutdown = async () => {
    await db.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
