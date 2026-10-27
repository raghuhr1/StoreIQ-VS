import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { authFromToken, type AuthContext } from "@/server/auth/context";
import { db } from "@/server/db";
import { runOnce } from "@/server/jobs/worker-loop";
import { login } from "@/server/services/auth";
import { createMember } from "@/server/services/users";
import { createStore } from "@/server/services/stores";
import { createTenantWithAdmin } from "@/server/services/tenants";
import { changePassword } from "@/server/services/auth";
import { ingestUpload } from "@/server/services/uploads";

export const PASSWORD = "correct-horse-battery-staple";

export async function ctxFor(email: string, password = PASSWORD): Promise<AuthContext & { token: string }> {
  const s = await login(
    { email, password },
    {
      ip: `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      requestId: randomUUID(),
    },
  );
  const ctx = await authFromToken(s.token, { requestId: randomUUID(), ip: "127.0.0.1" });
  if (!ctx) throw new Error("login failed");
  return { ...ctx, token: s.token };
}

/** A tenant with an admin context and one store (Sales Floor + Back Room). */
export async function makeTenant(label = "t") {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const email = `${slug}@example.test`;
  await createTenantWithAdmin({
    tenantName: `Tenant ${slug}`,
    slug,
    adminEmail: email,
    adminName: "Admin",
    adminPassword: PASSWORD,
  });
  const admin = await ctxFor(email);
  const store = await createStore(admin, { name: "Store 1", code: "S1", timeZone: "UTC" });
  const sf = store.zones.find((z) => z.code === "SALES_FLOOR")!;
  const br = store.zones.find((z) => z.code === "BACK_ROOM")!;
  return { admin, store, sf, br, slug, email };
}

/** Add a user with a role and return a ready context (temporary password changed). */
export async function addUser(admin: AuthContext, role: "ADMIN" | "MANAGER" | "OPERATOR" | "VIEWER") {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
  const { temporaryPassword } = await createMember(admin, { email, name: role, role });
  const tmp = await ctxFor(email, temporaryPassword!);
  await changePassword(tmp, { currentPassword: temporaryPassword!, newPassword: PASSWORD });
  return ctxFor(email);
}

export function upload(
  ctx: AuthContext,
  storeId: string,
  filename: string,
  content: string | Buffer,
  extra: { zoneId?: string; sessionLabel?: string } = {},
) {
  return ingestUpload(ctx, { storeId, filename, body: Readable.from([Buffer.from(content)]), ...extra });
}

/** Drain the job queue (synchronous worker for tests). */
export async function drainQueue(max = 20) {
  for (let i = 0; i < max; i++) if (!(await runOnce("test-worker"))) return;
}

export async function streamToString(body: ReadableStream<Uint8Array>) {
  return Buffer.from(await new Response(body).arrayBuffer()).toString("utf8");
}

export { db };
