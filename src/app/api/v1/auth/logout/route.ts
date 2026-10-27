import { clearedSessionCookie, invalidateSession, readCookie, SESSION_COOKIE } from "@/server/auth/session";
import { publicRoute } from "@/server/http";

export const POST = publicRoute(async (req) => {
  const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  if (token) await invalidateSession(token);
  return Response.json({ data: null }, { headers: { "set-cookie": clearedSessionCookie() } });
});
