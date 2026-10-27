import type { Role } from "@/generated/prisma/enums";
import { db } from "../db";
import { AppError, forbidden } from "../errors";
import { can, type Permission } from "./rbac";
import { validateSessionToken } from "./session";

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  mustChangePassword: boolean;
  sessionId: string;
  /** Active tenant, always validated against the user's memberships server-side. */
  tenantId: string;
  tenantName: string;
  role: Role;
  memberships: { tenantId: string; tenantName: string; role: Role }[];
  requestId: string;
  ip: string | null;
}

export async function authFromToken(
  token: string | null | undefined,
  meta: { requestId: string; ip: string | null },
): Promise<AuthContext | null> {
  const session = await validateSessionToken(token);
  if (!session) return null;
  const memberships = await db().membership.findMany({
    where: { userId: session.userId },
    include: { tenant: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) return null;
  const active = memberships.find((m) => m.tenantId === session.activeTenantId) ?? memberships[0];
  return {
    userId: session.userId,
    email: session.user.email,
    name: session.user.name,
    mustChangePassword: session.user.mustChangePassword,
    sessionId: session.id,
    tenantId: active.tenantId,
    tenantName: active.tenant.name,
    role: active.role,
    memberships: memberships.map((m) => ({ tenantId: m.tenantId, tenantName: m.tenant.name, role: m.role })),
    requestId: meta.requestId,
    ip: meta.ip,
  };
}

export function requirePermission(
  ctx: AuthContext | null,
  permission: Permission,
): asserts ctx is AuthContext {
  if (!ctx) throw new AppError("UNAUTHENTICATED", "Sign in required");
  if (!can(ctx.role, permission)) throw forbidden();
}
