import { apiRoute, pageParams, paged } from "@/server/http";
import { listAudit } from "@/server/services/users";

export const GET = apiRoute({ permission: "audit:read" }, async ({ req, ctx }) => {
  const url = new URL(req.url);
  const p = pageParams(url);
  return paged(
    await listAudit(ctx, { action: url.searchParams.get("action")?.slice(0, 60) || undefined, ...p }),
    p,
  );
});
