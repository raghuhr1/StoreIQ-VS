import { z } from "zod";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { generateTemporaryPassword, hashPassword } from "../auth/password";
import { invalidateUserSessions } from "../auth/session";
import { audit } from "../audit";
import { db, withTenant } from "../db";
import { AppError, notFound } from "../errors";

const role = z.enum(["ADMIN", "MANAGER", "OPERATOR", "VIEWER"]);
export const createUserInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  role,
});

export async function listMembers(ctx: AuthContext) {
  requirePermission(ctx, "users:manage");
  const members = await db().membership.findMany({
    where: { tenantId: ctx.tenantId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          disabledAt: true,
          lastLoginAt: true,
          mustChangePassword: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return members.map((m) => ({ membershipId: m.id, role: m.role, createdAt: m.createdAt, ...m.user }));
}

/**
 * Add a user to the active tenant. New accounts get a temporary password that
 * is returned once (no email service is configured) and must be changed at
 * first sign-in. Existing accounts are simply added to this tenant.
 */
export async function createMember(ctx: AuthContext, raw: unknown) {
  requirePermission(ctx, "users:manage");
  const input = createUserInput.parse(raw);
  let temporaryPassword: string | undefined;
  let user = await db().user.findUnique({ where: { email: input.email } });
  if (!user) {
    temporaryPassword = generateTemporaryPassword();
    user = await db().user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
      },
    });
  }
  if (
    await db().membership.findUnique({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId: user.id } },
    })
  )
    throw new AppError("CONFLICT", "User is already a member");
  await db().membership.create({ data: { tenantId: ctx.tenantId, userId: user.id, role: input.role } });
  await withTenant(ctx.tenantId, (tx) =>
    audit(tx, ctx, "MEMBER_ADDED", { type: "User", id: user.id }, { role: input.role }),
  );
  return { userId: user.id, email: user.email, temporaryPassword };
}

async function adminCount(tenantId: string) {
  return db().membership.count({ where: { tenantId, role: "ADMIN", user: { disabledAt: null } } });
}

export async function updateMember(ctx: AuthContext, userId: string, raw: unknown) {
  requirePermission(ctx, "users:manage");
  const input = z.object({ role: role.optional(), disabled: z.boolean().optional() }).parse(raw);
  const m = await db().membership.findUnique({
    where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
  });
  if (!m) throw notFound("Member");
  const demoting =
    (input.role && input.role !== "ADMIN" && m.role === "ADMIN") || (input.disabled && m.role === "ADMIN");
  if (demoting && (await adminCount(ctx.tenantId)) <= 1)
    throw new AppError("CONFLICT", "A tenant must keep at least one active administrator");
  if (input.role) await db().membership.update({ where: { id: m.id }, data: { role: input.role } });
  if (input.disabled !== undefined) {
    // Disabling is account-wide; only allowed when the account belongs solely to this tenant.
    const tenants = await db().membership.count({ where: { userId } });
    if (tenants > 1)
      throw new AppError("CONFLICT", "User belongs to other organizations; remove the membership instead");
    await db().user.update({
      where: { id: userId },
      data: { disabledAt: input.disabled ? new Date() : null },
    });
    if (input.disabled) await invalidateUserSessions(userId);
  }
  await withTenant(ctx.tenantId, (tx) =>
    audit(tx, ctx, "MEMBER_UPDATED", { type: "User", id: userId }, input),
  );
}

export async function removeMember(ctx: AuthContext, userId: string) {
  requirePermission(ctx, "users:manage");
  const m = await db().membership.findUnique({
    where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
  });
  if (!m) throw notFound("Member");
  if (m.role === "ADMIN" && (await adminCount(ctx.tenantId)) <= 1)
    throw new AppError("CONFLICT", "Cannot remove the last administrator");
  await db().membership.delete({ where: { id: m.id } });
  await db().session.updateMany({
    where: { userId, activeTenantId: ctx.tenantId },
    data: { activeTenantId: null },
  });
  await withTenant(ctx.tenantId, (tx) => audit(tx, ctx, "MEMBER_REMOVED", { type: "User", id: userId }));
}

export async function listAudit(
  ctx: AuthContext,
  filter: { action?: string; limit: number; offset: number },
) {
  requirePermission(ctx, "audit:read");
  return withTenant(ctx.tenantId, async (tx) => {
    const where = { tenantId: ctx.tenantId, ...(filter.action ? { action: filter.action } : {}) };
    const [items, total] = await Promise.all([
      tx.auditEvent.findMany({ where, orderBy: { id: "desc" }, take: filter.limit, skip: filter.offset }),
      tx.auditEvent.count({ where }),
    ]);
    return { items: items.map((i) => ({ ...i, id: i.id.toString() })), total };
  });
}
