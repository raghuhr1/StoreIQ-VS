import { defineConfig } from "prisma/config";

// Load .env when present (Node >= 20.12). Real environments inject variables.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations run as the schema owner; the application uses DATABASE_URL
  // (a non-owner role subject to row-level security).
  datasource: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "" },
});
