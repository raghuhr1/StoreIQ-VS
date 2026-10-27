import { apiRoute, ok, readJson } from "@/server/http";
import { createStore, listStores } from "@/server/services/stores";

export const GET = apiRoute({ permission: "store:read" }, async ({ ctx }) => ok(await listStores(ctx)));
export const POST = apiRoute({ permission: "store:write" }, async ({ req, ctx }) =>
  ok(await createStore(ctx, await readJson(req))),
);
