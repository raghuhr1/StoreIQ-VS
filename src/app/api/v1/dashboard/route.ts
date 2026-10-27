import { apiRoute, ok } from "@/server/http";
import { dashboard } from "@/server/services/dashboard";

export const GET = apiRoute({ permission: "dashboard:read" }, async ({ ctx }) => ok(await dashboard(ctx)));
