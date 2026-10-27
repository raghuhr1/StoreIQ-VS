import { inject } from "vitest";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.MIGRATION_DATABASE_URL = inject("ownerDatabaseUrl");
process.env.STORAGE_DRIVER = "local";
process.env.LOCAL_STORAGE_DIR = inject("storageDir");
process.env.APP_URL = "http://localhost:3000";
process.env.LOG_LEVEL = "silent";

import { afterAll } from "vitest";
afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const { disconnectDb } = await import("@/server/db");
  await disconnectDb();
});
