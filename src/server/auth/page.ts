import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { authFromToken, type AuthContext } from "./context";
import { SESSION_COOKIE } from "./session";

/** Resolve the signed-in user for a server component; redirects to /login when absent. */
export async function pageAuth(opts: { allowPasswordChange?: boolean } = {}): Promise<AuthContext> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const h = await headers();
  const ctx = await authFromToken(token, {
    requestId: h.get("x-request-id") ?? randomUUID(),
    ip: h.get("x-forwarded-for")?.split(",")[0] ?? null,
  });
  if (!ctx) redirect("/login");
  if (ctx.mustChangePassword && !opts.allowPasswordChange) redirect("/change-password");
  return ctx;
}
