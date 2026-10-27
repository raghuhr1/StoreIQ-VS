import { apiRoute, ok } from "@/server/http";
import { AppError } from "@/server/errors";
import { createDataset, listDatasets } from "@/server/services/calibration";

export const GET = apiRoute({ permission: "calibration:read" }, async ({ req, ctx }) =>
  ok(await listDatasets(ctx, new URL(req.url).searchParams.get("storeId") ?? undefined)),
);

/** Body: label CSV (epc, actual_zone[, category][, notes]). Metadata in query parameters. */
export const POST = apiRoute({ permission: "calibration:write" }, async ({ req, ctx }) => {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 20 * 1024 * 1024)
    throw new AppError("PAYLOAD_TOO_LARGE", "Label file is too large (20 MB maximum)");
  const sp = new URL(req.url).searchParams;
  const meta = {
    storeId: sp.get("storeId"),
    name: sp.get("name"),
    purpose: sp.get("purpose"),
    jobId: sp.get("jobId") || null,
    notes: sp.get("notes") ?? undefined,
  };
  return ok(await createDataset(ctx, meta, await req.text()));
});
