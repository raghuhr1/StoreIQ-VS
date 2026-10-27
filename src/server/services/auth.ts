import { z } from "zod";
import type { AuthContext } from "../auth/context";
import { hashPassword, passwordProblems, verifyPassword } from "../auth/password";
import { createSession, hashToken, invalidateUserSessions } from "../auth/session";
import { audit } from "../audit";
import { config } from "../config";
import { db, withTenant } from "../db";
import { AppError, invalid } from "../errors";
import { rateLimit } from "../ratelimit";

const loginInput = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().max(256),
});

// Pre-computed hash so unknown emails take the same time as wrong passwords.
let dummyHash: Promise<string> | null = null;

export async function login(raw: unknown, meta: { ip: string | null; requestId: string }) {
  const { email, password } = loginInput.parse(raw);
  await rateLimit(`login:${meta.ip ?? "unknown"}:${email}`, config().LOGIN_RATE_LIMIT_PER_15MIN, 15 * 60);
  const user = await db().user.findUnique({
    where: { email },
    include: { memberships: { orderBy: { createdAt: "asc" } } },
  });
  dummyHash ??= hashPassword("dummy-password-for-timing");
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  if (!user || !ok || user.disabledAt || user.memberships.length === 0)
    throw new AppError("UNAUTHENTICATED", "Invalid email or password");
  const tenantId = user.memberships[0].tenantId;
  const session = await createSession(user.id, tenantId);
  await db().user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await withTenant(tenantId, (tx) =>
    audit(tx, { tenantId, userId: user.id, requestId: meta.requestId, ip: meta.ip }, "USER_LOGIN", {
      type: "User",
      id: user.id,
    }),
  );
  return { ...session, mustChangePassword: user.mustChangePassword };
}

const changeInput = z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) });

/** Change password; works while a temporary password is still pending. Revokes other sessions. */
export async function changePassword(
  ctx: Pick<AuthContext, "userId" | "email" | "sessionId" | "tenantId" | "requestId" | "ip">,
  raw: unknown,
) {
  const input = changeInput.parse(raw);
  const user = await db().user.findUniqueOrThrow({ where: { id: ctx.userId } });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
    throw invalid("Current password is incorrect");
  const problems = passwordProblems(input.newPassword, ctx.email);
  if (input.newPassword === input.currentPassword)
    problems.push("New password must differ from the current one");
  if (problems.length) throw invalid(problems.join("; "));
  await db().user.update({
    where: { id: ctx.userId },
    data: { passwordHash: await hashPassword(input.newPassword), mustChangePassword: false },
  });
  await invalidateUserSessions(ctx.userId, ctx.sessionId);
  await withTenant(ctx.tenantId, (tx) =>
    audit(tx, { ...ctx }, "PASSWORD_CHANGED", { type: "User", id: ctx.userId }),
  );
}

export async function switchTenant(ctx: AuthContext, tenantId: string) {
  if (!ctx.memberships.some((m) => m.tenantId === tenantId))
    throw new AppError("FORBIDDEN", "You are not a member of that organization");
  await db().session.update({ where: { id: ctx.sessionId }, data: { activeTenantId: tenantId } });
}

export { hashToken };
