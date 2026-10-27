import { z } from "zod";
import { apiRoute, pageParams, paged } from "@/server/http";
import { listExceptions } from "@/server/services/results";

const q = z.object({
  zoneId: z.string().uuid().optional(),
  reasonCode: z.string().max(60).optional(),
  search: z.string().max(64).optional(),
});

export const GET = apiRoute<{ jobId: string }>(
  { permission: "results:read" },
  async ({ req, ctx, params }) => {
    const url = new URL(req.url);
    const p = pageParams(url);
    const f = q.parse(Object.fromEntries([...url.searchParams].filter(([k]) => k in q.shape)));
    const r = await listExceptions(ctx, params.jobId, { ...f, ...p });
    return paged(r, p, { byReason: r.byReason });
  },
);
