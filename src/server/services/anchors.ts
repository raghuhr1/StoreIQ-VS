import { z } from "zod";
import { normalizeEpc, resolveProfile } from "@/engine";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { audit } from "../audit";
import { withTenant } from "../db";
import { AppError, invalid, notFound } from "../errors";
import { getStoreOrThrow } from "./stores";
import { getDefaultProfile } from "./profiles";

const anchorInput = z.object({
  epc: z.string().min(1).max(256),
  zoneId: z.string().uuid(),
  description: z.string().trim().max(200).optional(),
});

export async function listAnchors(ctx: AuthContext, storeId: string) {
  requirePermission(ctx, "anchor:read");
  return withTenant(ctx.tenantId, async (tx) => {
    await getStoreOrThrow(tx, ctx.tenantId, storeId);
    return tx.anchorTag.findMany({
      where: { tenantId: ctx.tenantId, storeId },
      orderBy: [{ active: "desc" }, { epc: "asc" }],
      include: { zone: true },
    });
  });
}

export async function registerAnchor(ctx: AuthContext, storeId: string, raw: unknown) {
  requirePermission(ctx, "anchor:write");
  const input = anchorInput.parse(raw);
  return withTenant(ctx.tenantId, async (tx) => {
    await getStoreOrThrow(tx, ctx.tenantId, storeId);
    const zone = await tx.zone.findFirst({ where: { id: input.zoneId, storeId, tenantId: ctx.tenantId } });
    if (!zone) throw notFound("Zone");
    const profile = resolveProfile((await getDefaultProfile(tx, ctx.tenantId)).config);
    const n = normalizeEpc(input.epc, profile.epc);
    if (!n.valid) throw invalid(`Anchor EPC is not valid under the default EPC profile (${n.issue})`);
    if (await tx.anchorTag.findFirst({ where: { storeId, epc: n.epc } }))
      throw new AppError("CONFLICT", "This EPC is already registered as an anchor");
    const anchor = await tx.anchorTag.create({
      data: { tenantId: ctx.tenantId, storeId, zoneId: zone.id, epc: n.epc, description: input.description },
    });
    await audit(
      tx,
      ctx,
      "ANCHOR_REGISTERED",
      { type: "AnchorTag", id: anchor.id },
      { storeId, zone: zone.code },
    );
    return anchor;
  });
}

export async function setAnchorActive(ctx: AuthContext, storeId: string, anchorId: string, active: boolean) {
  requirePermission(ctx, "anchor:write");
  return withTenant(ctx.tenantId, async (tx) => {
    const a = await tx.anchorTag.findFirst({ where: { id: anchorId, storeId, tenantId: ctx.tenantId } });
    if (!a) throw notFound("Anchor");
    const updated = await tx.anchorTag.update({
      where: { id: anchorId },
      data: { active, deactivatedAt: active ? null : new Date() },
    });
    await audit(tx, ctx, active ? "ANCHOR_ACTIVATED" : "ANCHOR_DEACTIVATED", {
      type: "AnchorTag",
      id: anchorId,
    });
    return updated;
  });
}
