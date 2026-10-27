import { DEFAULT_PROFILE, RULES_VERSION } from "@/engine";
import { apiRoute, ok, readJson } from "@/server/http";
import { createProfileVersion, listProfiles } from "@/server/services/profiles";

export const GET = apiRoute({ permission: "profile:read" }, async ({ ctx }) =>
  ok(await listProfiles(ctx), { rulesVersion: RULES_VERSION, defaults: DEFAULT_PROFILE }),
);
/** Creates a new immutable version (existing versions are never edited). */
export const POST = apiRoute({ permission: "profile:write" }, async ({ req, ctx }) =>
  ok(await createProfileVersion(ctx, await readJson(req))),
);
