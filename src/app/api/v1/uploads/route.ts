import { z } from "zod";
import { apiRoute, ok, pageParams, paged } from "@/server/http";
import { ingestUpload, listUploads } from "@/server/services/uploads";

export const GET = apiRoute({ permission: "store:read" }, async ({ req, ctx }) => {
  const url = new URL(req.url);
  const p = pageParams(url);
  return paged(await listUploads(ctx, { storeId: url.searchParams.get("storeId") ?? undefined, ...p }), p);
});

const query = z.object({
  storeId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  zoneId: z.string().uuid().optional(),
  sessionLabel: z.string().max(120).optional(),
});

/**
 * Upload a scan export. The request body is the raw CSV file (streamed, not
 * multipart); metadata is passed as query parameters.
 */
export const POST = apiRoute({ permission: "upload:write" }, async ({ req, ctx }) => {
  const q = query.parse(Object.fromEntries(new URL(req.url).searchParams));
  return ok(await ingestUpload(ctx, { ...q, body: req.body }));
});
