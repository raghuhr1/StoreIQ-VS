import { apiRoute, ok } from "@/server/http";
import { calibrationSuggestions } from "@/server/services/calibration";

export const GET = apiRoute<{ datasetId: string }>(
  { permission: "calibration:read" },
  async ({ ctx, params }) => ok(await calibrationSuggestions(ctx, params.datasetId)),
);
