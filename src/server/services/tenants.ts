import { DEFAULT_PROFILE, RULES_VERSION } from "@/engine";
import { generateTemporaryPassword, hashPassword, passwordProblems } from "../auth/password";
import { audit } from "../audit";
import { db, withTenant } from "../db";
import { AppError, invalid } from "../errors";

export interface CreateTenantInput {
  tenantName: string;
  slug: string;
  adminEmail: string;
  adminName: string;
  /** Omit to generate a temporary password that must be changed at first login. */
  adminPassword?: string;
}

/** Bootstrap a tenant with its first administrator and a default processing profile. */
export async function createTenantWithAdmin(input: CreateTenantInput) {
  const email = input.adminEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalid("Invalid admin email");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug))
    throw invalid("Slug must be lowercase letters, digits and hyphens");
  const temporary = !input.adminPassword;
  const password = input.adminPassword ?? generateTemporaryPassword();
  if (!temporary) {
    const problems = passwordProblems(password, email);
    if (problems.length) throw invalid(problems.join("; "));
  }
  if (await db().tenant.findUnique({ where: { slug: input.slug } }))
    throw new AppError("CONFLICT", "Tenant slug already exists");

  const passwordHash = await hashPassword(password);
  const { tenant, user, existingUser } = await db().$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: input.tenantName.trim(), slug: input.slug } });
    const existing = await tx.user.findUnique({ where: { email } });
    const user =
      existing ??
      (await tx.user.create({
        data: { email, name: input.adminName.trim(), passwordHash, mustChangePassword: temporary },
      }));
    await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "ADMIN" } });
    return { tenant, user, existingUser: !!existing };
  });
  await withTenant(tenant.id, async (tx) => {
    await tx.processingProfile.create({
      data: {
        tenantId: tenant.id,
        name: "Default",
        version: 1,
        config: DEFAULT_PROFILE,
        rulesVersion: RULES_VERSION,
        isDefault: true,
        notes: "Initial conservative defaults (uncalibrated)",
      },
    });
    await audit(
      tx,
      { tenantId: tenant.id, userId: null },
      "TENANT_CREATED",
      { type: "Tenant", id: tenant.id },
      { adminUserId: user.id },
    );
  });
  return {
    tenantId: tenant.id,
    userId: user.id,
    temporaryPassword: temporary && !existingUser ? password : undefined,
    existingUser,
  };
}
