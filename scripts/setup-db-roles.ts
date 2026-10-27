/**
 * Grants LOGIN to the application role and sets its password.
 * Run after `npm run db:migrate` in each environment:
 *   MIGRATION_DATABASE_URL=... APP_DB_PASSWORD=... npm run db:setup-roles
 */
import { configureAppRole } from "./lib/embedded-db";

try {
  process.loadEnvFile();
} catch {
  /* optional */
}

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appPassword = process.env.APP_DB_PASSWORD;
if (!ownerUrl || !appPassword || appPassword.length < 16) {
  console.error("MIGRATION_DATABASE_URL and APP_DB_PASSWORD (>= 16 chars) are required.");
  process.exit(1);
}
configureAppRole(ownerUrl, appPassword)
  .then(() => console.log("vshield_app role configured."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
