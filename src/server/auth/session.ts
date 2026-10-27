import { createHash, randomBytes } from "node:crypto";
import { config, isProduction } from "../config";
import { db } from "../db";

export const SESSION_COOKIE = isProduction() ? "__Host-svs_session" : "svs_session";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string, activeTenantId: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + config().SESSION_TTL_HOURS * 3_600_000);
  await db().session.create({ data: { id: hashToken(token), userId, activeTenantId, expiresAt } });
  return { token, expiresAt };
}

/** Validate a session token; enforces absolute expiry, idle timeout and disabled users. */
export async function validateSessionToken(token: string | undefined | null) {
  if (!token || token.length > 100) return null;
  const id = hashToken(token);
  const session = await db().session.findUnique({ where: { id }, include: { user: true } });
  if (!session) return null;
  const now = Date.now();
  const idleMs = config().SESSION_IDLE_MINUTES * 60_000;
  if (
    session.expiresAt.getTime() <= now ||
    now - session.lastSeenAt.getTime() > idleMs ||
    session.user.disabledAt
  ) {
    await db().session.deleteMany({ where: { id } });
    return null;
  }
  if (now - session.lastSeenAt.getTime() > 60_000)
    await db().session.update({ where: { id }, data: { lastSeenAt: new Date(now) } });
  return session;
}

export async function invalidateSession(token: string) {
  await db().session.deleteMany({ where: { id: hashToken(token) } });
}

export async function invalidateUserSessions(userId: string, exceptTokenHash?: string) {
  await db().session.deleteMany({
    where: { userId, ...(exceptTokenHash ? { NOT: { id: exceptTokenHash } } : {}) },
  });
}

export function sessionCookie(token: string, expiresAt: Date) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (isProduction()) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProduction() ? "; Secure" : ""}`;
}

export function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
