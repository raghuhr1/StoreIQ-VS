import { apiRoute, ok, readJson } from "@/server/http";
import { setRelationship } from "@/server/services/stores";

export const PUT = apiRoute<{ storeId: string }>(
  { permission: "store:write" },
  async ({ req, ctx, params }) => ok(await setRelationship(ctx, params.storeId, await readJson(req))),
);
