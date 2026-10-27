import { sessionCookie } from "@/server/auth/session";
import { clientIp, publicRoute, readJson } from "@/server/http";
import { login } from "@/server/services/auth";

export const POST = publicRoute(async (req, requestId) => {
  const s = await login(await readJson(req), { ip: clientIp(req), requestId });
  return Response.json(
    { data: { mustChangePassword: s.mustChangePassword, expiresAt: s.expiresAt } },
    { headers: { "set-cookie": sessionCookie(s.token, s.expiresAt) } },
  );
});
