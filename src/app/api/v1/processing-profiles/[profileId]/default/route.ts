import { apiRoute, ok } from "@/server/http";
import { setDefaultProfile } from "@/server/services/profiles";

export const POST = apiRoute<{ profileId: string }>(
  { permission: "profile:write" },
  async ({ ctx, params }) => {
    await setDefaultProfile(ctx, params.profileId);
    return ok(null);
  },
);
