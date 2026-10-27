import { z } from "zod";
import { apiRoute, ok, readJson } from "@/server/http";
import { evaluateJob, listEvaluations } from "@/server/services/calibration";

type P = { jobId: string };
export const GET = apiRoute<P>({ permission: "calibration:read" }, async ({ ctx, params }) =>
  ok(await listEvaluations(ctx, params.jobId)),
);
export const POST = apiRoute<P>({ permission: "calibration:write" }, async ({ req, ctx, params }) => {
  const { datasetId } = z.object({ datasetId: z.string().uuid() }).parse(await readJson(req));
  return ok(await evaluateJob(ctx, params.jobId, datasetId));
});
