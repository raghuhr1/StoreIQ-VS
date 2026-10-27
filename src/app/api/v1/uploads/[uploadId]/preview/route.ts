import { apiRoute, ok } from "@/server/http";
import { previewUpload } from "@/server/services/uploads";

export const GET = apiRoute<{ uploadId: string }>({ permission: "upload:write" }, async ({ ctx, params }) =>
  ok(await previewUpload(ctx, params.uploadId)),
);
