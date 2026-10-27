/**
 * Create a tenant and its first administrator.
 *
 *   npm run tenant:create -- --name "Acme Retail" --slug acme --email admin@acme.example --admin-name "Jane Doe"
 *
 * The admin password is read from the ADMIN_PASSWORD environment variable if
 * set; otherwise a temporary password is generated, printed once, and must be
 * changed at first sign-in. Never pass passwords as command-line arguments.
 */
import { parseArgs } from "node:util";
import { disconnectDb } from "@/server/db";
import { createTenantWithAdmin } from "@/server/services/tenants";

try {
  process.loadEnvFile();
} catch {
  /* optional */
}

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    slug: { type: "string" },
    email: { type: "string" },
    "admin-name": { type: "string" },
  },
});
if (!values.name || !values.slug || !values.email) {
  console.error(
    'Usage: npm run tenant:create -- --name "Tenant" --slug tenant --email admin@example.com [--admin-name "Name"]',
  );
  process.exit(1);
}

createTenantWithAdmin({
  tenantName: values.name,
  slug: values.slug,
  adminEmail: values.email,
  adminName: values["admin-name"] ?? "Administrator",
  adminPassword: process.env.ADMIN_PASSWORD || undefined,
})
  .then(async (r) => {
    console.log(`Tenant created: ${r.tenantId}`);
    if (r.existingUser) console.log(`Existing user ${values.email} was added as ADMIN (password unchanged).`);
    else if (r.temporaryPassword)
      console.log(
        `Temporary password for ${values.email} (shown once, change at first sign-in): ${r.temporaryPassword}`,
      );
    else console.log(`Admin ${values.email} created with the password from ADMIN_PASSWORD.`);
    await disconnectDb();
  })
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await disconnectDb();
    process.exit(1);
  });
