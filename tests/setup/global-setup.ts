import type { TestProject } from "vitest/node";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEmbeddedDb, type EmbeddedDb } from "../../scripts/lib/embedded-db";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    ownerDatabaseUrl: string;
    storageDir: string;
  }
}

let db: EmbeddedDb | null = null;
let tmp: string | null = null;

export default async function setup(project: TestProject) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "svs-test-"));
  const storageDir = path.join(tmp, "storage");
  fs.mkdirSync(storageDir);
  project.provide("storageDir", storageDir);
  if (process.env.SKIP_DB === "1") {
    project.provide("databaseUrl", "");
    project.provide("ownerDatabaseUrl", "");
    return;
  }
  const port = 55000 + Math.floor(Math.random() * 2000);
  db = await startEmbeddedDb({
    dir: path.join(tmp, "pg"),
    port,
    dbName: "svs_test",
    ownerPassword: "owner-test-pw",
    appPassword: "app-test-pw",
    persistent: false,
    quiet: true,
  });
  project.provide("databaseUrl", db.appUrl);
  project.provide("ownerDatabaseUrl", db.ownerUrl);
}

export async function teardown() {
  if (db) await db.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}
