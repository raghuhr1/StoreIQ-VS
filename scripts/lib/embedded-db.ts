/**
 * Development/test helper: runs a real PostgreSQL server from the
 * `embedded-postgres` package (no Docker required), applies migrations and
 * configures the non-owner application role used for row-level security.
 * Not used in production.
 */
import EmbeddedPostgres from "embedded-postgres";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

export interface EmbeddedDbOptions {
  dir: string;
  port: number;
  dbName: string;
  ownerPassword: string;
  appPassword: string;
  persistent: boolean;
  quiet?: boolean;
}

export interface EmbeddedDb {
  ownerUrl: string;
  appUrl: string;
  stop: () => Promise<void>;
}

export function migrate(ownerUrl: string) {
  const prismaBin = path.resolve("node_modules/prisma/build/index.js");
  execFileSync(process.execPath, [prismaBin, "migrate", "deploy"], {
    env: { ...process.env, MIGRATION_DATABASE_URL: ownerUrl },
    stdio: "pipe",
  });
}

export async function configureAppRole(ownerUrl: string, appPassword: string) {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // Identifier is fixed; password is passed as a literal via format().
    const { rows } = await client.query(
      "SELECT format('ALTER ROLE vshield_app LOGIN PASSWORD %L', $1::text) AS sql",
      [appPassword],
    );
    await client.query(rows[0].sql);
  } finally {
    await client.end();
  }
}

export async function startEmbeddedDb(opts: EmbeddedDbOptions): Promise<EmbeddedDb> {
  const log = opts.quiet ? () => {} : (m: unknown) => console.log(String(m));
  const pgServer = new EmbeddedPostgres({
    databaseDir: opts.dir,
    port: opts.port,
    user: "postgres",
    password: opts.ownerPassword,
    persistent: opts.persistent,
    authMethod: "scram-sha-256",
    onLog: () => {},
    onError: opts.quiet ? () => {} : (e) => console.error(String(e)),
  });
  if (!fs.existsSync(path.join(opts.dir, "PG_VERSION"))) {
    log(`Initialising PostgreSQL cluster in ${opts.dir}`);
    await pgServer.initialise();
  }
  await pgServer.start();

  const admin = pgServer.getPgClient("postgres", "localhost");
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [opts.dbName]);
  await admin.end();
  if (exists.rowCount === 0) await pgServer.createDatabase(opts.dbName);

  const ownerUrl = `postgresql://postgres:${encodeURIComponent(opts.ownerPassword)}@localhost:${opts.port}/${opts.dbName}`;
  const appUrl = `postgresql://vshield_app:${encodeURIComponent(opts.appPassword)}@localhost:${opts.port}/${opts.dbName}`;
  migrate(ownerUrl);
  await configureAppRole(ownerUrl, opts.appPassword);
  return { ownerUrl, appUrl, stop: () => pgServer.stop() };
}
