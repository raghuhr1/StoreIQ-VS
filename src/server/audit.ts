import type { Prisma } from "@/generated/prisma/client";
import type { AuthContext } from "./auth/context";
import type { Tx } from "./db";

/**
 * Append an audit event inside the caller's tenant transaction. Metadata must
 * not contain secrets or raw RFID rows (identifiers and counts only).
 */
export async function audit(
  tx: Tx,
  ctx:
    | Pick<AuthContext, "tenantId" | "userId" | "requestId" | "ip">
    | { tenantId: string; userId: null; requestId?: string; ip?: string | null },
  action: string,
  target: { type?: string; id?: string } = {},
  metadata: Prisma.InputJsonValue = {},
) {
  await tx.auditEvent.create({
    data: {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: target.type,
      targetId: target.id,
      metadata,
      ip: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
    },
  });
}
