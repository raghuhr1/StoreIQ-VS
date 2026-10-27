import { apiRoute, ok, readJson } from "@/server/http";
import { createMember, listMembers } from "@/server/services/users";

export const GET = apiRoute({ permission: "users:manage" }, async ({ ctx }) => ok(await listMembers(ctx)));
/** Returns `temporaryPassword` once for new accounts; it is never retrievable again. */
export const POST = apiRoute({ permission: "users:manage" }, async ({ req, ctx }) =>
  ok(await createMember(ctx, await readJson(req))),
);
