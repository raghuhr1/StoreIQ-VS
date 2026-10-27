import { z } from "zod";
import { apiRoute, ok, readJson } from "@/server/http";
import { switchTenant } from "@/server/services/auth";

export const POST = apiRoute({ permission: "dashboard:read" }, async ({ req, ctx }) => {
  const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(await readJson(req));
  await switchTenant(ctx, tenantId);
  return ok(null);
});
