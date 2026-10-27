import { z } from "zod";
import { apiRoute, pageParams, paged } from "@/server/http";
import { listObserved } from "@/server/services/results";

const q = z.object({ zoneId: z.string().uuid().optional(), search: z.string().max(64).optional() });

export const GET = apiRoute<{ jobId: string }>(
  { permission: "results:read" },
  async ({ req, ctx, params }) => {
    const url = new URL(req.url);
    const p = pageParams(url);
    const f = q.parse(Object.fromEntries([...url.searchParams].filter(([k]) => k in q.shape)));
    return paged(await listObserved(ctx, params.jobId, { ...f, ...p }), p);
  },
);
