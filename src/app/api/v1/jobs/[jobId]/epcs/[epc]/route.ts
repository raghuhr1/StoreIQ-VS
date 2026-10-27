import { apiRoute, ok } from "@/server/http";
import { epcTrace } from "@/server/services/results";

export const GET = apiRoute<{ jobId: string; epc: string }>(
  { permission: "results:read" },
  async ({ ctx, params }) =>
    ok(await epcTrace(ctx, params.jobId, decodeURIComponent(params.epc).slice(0, 256))),
);
