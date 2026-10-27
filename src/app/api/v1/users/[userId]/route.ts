import { apiRoute, ok, readJson } from "@/server/http";
import { removeMember, updateMember } from "@/server/services/users";

type P = { userId: string };
export const PATCH = apiRoute<P>({ permission: "users:manage" }, async ({ req, ctx, params }) => {
  await updateMember(ctx, params.userId, await readJson(req));
  return ok(null);
});
export const DELETE = apiRoute<P>({ permission: "users:manage" }, async ({ ctx, params }) => {
  await removeMember(ctx, params.userId);
  return ok(null);
});
