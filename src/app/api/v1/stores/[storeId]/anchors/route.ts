import { apiRoute, ok, readJson } from "@/server/http";
import { listAnchors, registerAnchor } from "@/server/services/anchors";

type P = { storeId: string };
export const GET = apiRoute<P>({ permission: "anchor:read" }, async ({ ctx, params }) =>
  ok(await listAnchors(ctx, params.storeId)),
);
export const POST = apiRoute<P>({ permission: "anchor:write" }, async ({ req, ctx, params }) =>
  ok(await registerAnchor(ctx, params.storeId, await readJson(req))),
);
