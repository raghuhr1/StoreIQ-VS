import { apiRoute, ok, readJson } from "@/server/http";
import { listMappingProfiles, saveMappingProfile } from "@/server/services/mappings";

export const GET = apiRoute({ permission: "store:read" }, async ({ req, ctx }) =>
  ok(await listMappingProfiles(ctx, new URL(req.url).searchParams.get("storeId") ?? undefined)),
);
export const POST = apiRoute({ permission: "mapping:write" }, async ({ req, ctx }) =>
  ok(await saveMappingProfile(ctx, await readJson(req))),
);
