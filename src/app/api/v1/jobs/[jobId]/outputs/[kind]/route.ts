import { apiRoute } from "@/server/http";
import { openOutput } from "@/server/services/results";

/** Download an output file. Proxied for local storage; 302 to a short-lived signed URL for S3. */
export const GET = apiRoute<{ jobId: string; kind: string }>(
  { permission: "results:download" },
  async ({ ctx, params }) => {
    const kind = params.kind.replace(/\.csv$/, "");
    if (!/^[a-z0-9_]{1,60}$/.test(kind))
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Output file not found" } },
        { status: 404 },
      );
    const out = await openOutput(ctx, params.jobId, kind);
    if (out.kind === "redirect") return Response.redirect(out.url, 302);
    return new Response(out.body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${out.filename}"`,
        "content-length": String(out.sizeBytes),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
);
