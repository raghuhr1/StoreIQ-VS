import { apiRoute, ok, readJson } from "@/server/http";
import { createZone } from "@/server/services/stores";

export const POST = apiRoute<{ storeId: string }>(
  { permission: "store:write" },
  async ({ req, ctx, params }) => ok(await createZone(ctx, params.storeId, await readJson(req))),
);
