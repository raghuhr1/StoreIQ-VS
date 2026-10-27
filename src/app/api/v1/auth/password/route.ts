import { authFromToken } from "@/server/auth/context";
import { readCookie, SESSION_COOKIE } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { clientIp, publicRoute, readJson } from "@/server/http";
import { changePassword } from "@/server/services/auth";

// Allowed while a temporary password is pending, so it bypasses the mustChangePassword gate.
export const POST = publicRoute(async (req, requestId) => {
  const ctx = await authFromToken(readCookie(req.headers.get("cookie"), SESSION_COOKIE), {
    requestId,
    ip: clientIp(req),
  });
  if (!ctx) throw new AppError("UNAUTHENTICATED", "Sign in required");
  await changePassword(ctx, await readJson(req));
  return Response.json({ data: null });
});
