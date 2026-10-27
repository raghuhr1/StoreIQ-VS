import { apiRoute, ok, readJson } from "@/server/http";
import { updateZone } from "@/server/services/stores";

export const PATCH = apiRoute<{ storeId: string; zoneId: string }>(
  { permission: "store:write" },
  async ({ req, ctx, params }) =>
    ok(await updateZone(ctx, params.storeId, params.zoneId, await readJson(req))),
);
