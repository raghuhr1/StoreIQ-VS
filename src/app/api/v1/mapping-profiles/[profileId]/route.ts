import { apiRoute, ok, readJson } from "@/server/http";
import { deleteMappingProfile, saveMappingProfile } from "@/server/services/mappings";

type P = { profileId: string };
export const PUT = apiRoute<P>({ permission: "mapping:write" }, async ({ req, ctx, params }) =>
  ok(await saveMappingProfile(ctx, await readJson(req), params.profileId)),
);
export const DELETE = apiRoute<P>({ permission: "mapping:write" }, async ({ ctx, params }) => {
  await deleteMappingProfile(ctx, params.profileId);
  return ok(null);
});
