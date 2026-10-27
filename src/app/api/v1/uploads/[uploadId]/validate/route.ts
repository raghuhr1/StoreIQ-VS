import { apiRoute, ok, readJson } from "@/server/http";
import { validateUpload } from "@/server/services/uploads";

export const POST = apiRoute<{ uploadId: string }>(
  { permission: "upload:write", noRateLimit: true },
  async ({ req, ctx, params }) => ok(await validateUpload(ctx, params.uploadId, await readJson(req))),
);
