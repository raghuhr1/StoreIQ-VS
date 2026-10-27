import { z } from "zod";
import { apiRoute, ok, readJson } from "@/server/http";
import { setAnchorActive } from "@/server/services/anchors";

export const PATCH = apiRoute<{ storeId: string; anchorId: string }>(
  { permission: "anchor:write" },
  async ({ req, ctx, params }) => {
    const { active } = z.object({ active: z.boolean() }).parse(await readJson(req));
    return ok(await setAnchorActive(ctx, params.storeId, params.anchorId, active));
  },
);
