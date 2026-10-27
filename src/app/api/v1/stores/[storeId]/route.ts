import { apiRoute, ok, readJson } from "@/server/http";
import { getStore, updateStore } from "@/server/services/stores";

type P = { storeId: string };
export const GET = apiRoute<P>({ permission: "store:read" }, async ({ ctx, params }) =>
  ok(await getStore(ctx, params.storeId)),
);
export const PATCH = apiRoute<P>({ permission: "store:write" }, async ({ req, ctx, params }) =>
  ok(await updateStore(ctx, params.storeId, await readJson(req))),
);
