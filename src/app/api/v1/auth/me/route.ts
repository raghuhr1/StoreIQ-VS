import { can, PERMISSIONS, type Permission } from "@/server/auth/rbac";
import { apiRoute, ok } from "@/server/http";

export const GET = apiRoute({ permission: "dashboard:read" }, async ({ ctx }) =>
  ok({
    user: { id: ctx.userId, email: ctx.email, name: ctx.name },
    tenant: { id: ctx.tenantId, name: ctx.tenantName },
    role: ctx.role,
    permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(ctx.role, p)),
    memberships: ctx.memberships,
  }),
);
