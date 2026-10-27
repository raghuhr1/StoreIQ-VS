import { z } from "zod";
import { RULES_VERSION, safeResolveProfile, type ProcessingProfileConfig } from "@/engine";
import type { ProcessingProfile } from "@/generated/prisma/client";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { audit } from "../audit";
import { withTenant, type Tx } from "../db";
import { invalid, notFound } from "../errors";

export const profileVersionLabel = (p: Pick<ProcessingProfile, "name" | "version" | "rulesVersion">) =>
  `${p.name}@v${p.version}/${p.rulesVersion}`;

const createInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[A-Za-z0-9 _-]+$/),
  storeId: z.string().uuid().nullable().optional(),
  config: z.unknown(),
  notes: z.string().max(500).optional(),
  isDefault: z.boolean().default(false),
  tunedFromJobIds: z.array(z.string().uuid()).max(100).default([]),
});

export async function listProfiles(ctx: AuthContext) {
  requirePermission(ctx, "profile:read");
  return withTenant(ctx.tenantId, (tx) =>
    tx.processingProfile.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: [{ name: "asc" }, { version: "desc" }],
    }),
  );
}

export async function getDefaultProfile(tx: Tx, tenantId: string) {
  const p = await tx.processingProfile.findFirst({
    where: { tenantId, isDefault: true },
    orderBy: { version: "desc" },
  });
  if (!p) throw notFound("Default processing profile");
  return p;
}

/**
 * Save a new immutable profile version. Existing versions are never modified,
 * so completed jobs remain reproducible.
 */
export async function createProfileVersion(ctx: AuthContext, raw: unknown) {
  requirePermission(ctx, "profile:write");
  const input = createInput.parse(raw);
  const parsed = safeResolveProfile(input.config);
  if (!parsed.success)
    throw invalid(
      "Invalid processing profile",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  const config: ProcessingProfileConfig = parsed.data;
  return withTenant(ctx.tenantId, async (tx) => {
    if (
      input.storeId &&
      !(await tx.store.findFirst({ where: { id: input.storeId, tenantId: ctx.tenantId } }))
    )
      throw notFound("Store");
    const last = await tx.processingProfile.findFirst({
      where: { tenantId: ctx.tenantId, name: input.name },
      orderBy: { version: "desc" },
    });
    if (input.isDefault)
      await tx.processingProfile.updateMany({
        where: { tenantId: ctx.tenantId, isDefault: true },
        data: { isDefault: false },
      });
    const created = await tx.processingProfile.create({
      data: {
        tenantId: ctx.tenantId,
        storeId: input.storeId ?? null,
        name: input.name,
        version: (last?.version ?? 0) + 1,
        config,
        rulesVersion: RULES_VERSION,
        isDefault: input.isDefault,
        notes: input.notes,
        tunedFromJobIds: input.tunedFromJobIds,
        createdById: ctx.userId,
      },
    });
    await audit(
      tx,
      ctx,
      "PROFILE_VERSION_CREATED",
      { type: "ProcessingProfile", id: created.id },
      { name: created.name, version: created.version, isDefault: created.isDefault },
    );
    return created;
  });
}

export async function setDefaultProfile(ctx: AuthContext, profileId: string) {
  requirePermission(ctx, "profile:write");
  return withTenant(ctx.tenantId, async (tx) => {
    const p = await tx.processingProfile.findFirst({ where: { id: profileId, tenantId: ctx.tenantId } });
    if (!p) throw notFound("Processing profile");
    await tx.processingProfile.updateMany({
      where: { tenantId: ctx.tenantId, isDefault: true },
      data: { isDefault: false },
    });
    await tx.processingProfile.update({ where: { id: profileId }, data: { isDefault: true } });
    await audit(tx, ctx, "PROFILE_DEFAULT_SET", { type: "ProcessingProfile", id: profileId });
  });
}
