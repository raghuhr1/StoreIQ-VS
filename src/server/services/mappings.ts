import { z } from "zod";
import { validateMapping } from "@/engine";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { audit } from "../audit";
import { withTenant } from "../db";
import { AppError, invalid, notFound } from "../errors";
import { fileMappingInput } from "./uploads";

const input = fileMappingInput.extend({
  name: z.string().trim().min(1).max(80),
  storeId: z.string().uuid().nullable().optional(),
  exportFormat: z.string().trim().max(120).optional(),
});

export async function listMappingProfiles(ctx: AuthContext, storeId?: string) {
  requirePermission(ctx, "store:read");
  return withTenant(ctx.tenantId, (tx) =>
    tx.columnMappingProfile.findMany({
      where: { tenantId: ctx.tenantId, ...(storeId ? { OR: [{ storeId: null }, { storeId }] } : {}) },
      orderBy: { name: "asc" },
    }),
  );
}

export async function saveMappingProfile(ctx: AuthContext, raw: unknown, id?: string) {
  requirePermission(ctx, "mapping:write");
  const data = input.parse(raw);
  if (!data.mapping.epc) throw invalid("A mapping profile must map the EPC column");
  // Column existence is checked against each file at validation time.
  const check = validateMapping(
    data.mapping,
    Object.values(data.mapping),
    data.mapping.zone ? null : "file-zone",
  );
  if (check.errors.length) throw invalid(check.errors.join("; "));
  return withTenant(ctx.tenantId, async (tx) => {
    if (data.storeId && !(await tx.store.findFirst({ where: { id: data.storeId, tenantId: ctx.tenantId } })))
      throw notFound("Store");
    const zoneIds = Object.values(data.zoneValueMap);
    if (
      zoneIds.length &&
      (await tx.zone.count({ where: { tenantId: ctx.tenantId, id: { in: zoneIds } } })) !==
        new Set(zoneIds).size
    )
      throw invalid("Zone value map refers to an unknown zone");
    const dup = await tx.columnMappingProfile.findFirst({
      where: { tenantId: ctx.tenantId, name: data.name, ...(id ? { NOT: { id } } : {}) },
    });
    if (dup) throw new AppError("CONFLICT", "A mapping profile with this name already exists");
    const fields = {
      name: data.name,
      storeId: data.storeId ?? null,
      exportFormat: data.exportFormat,
      mapping: data.mapping,
      dateFormat: data.dateFormat,
      zoneValueMap: data.zoneValueMap,
    };
    let saved;
    if (id) {
      if (!(await tx.columnMappingProfile.findFirst({ where: { id, tenantId: ctx.tenantId } })))
        throw notFound("Mapping profile");
      saved = await tx.columnMappingProfile.update({ where: { id }, data: fields });
    } else
      saved = await tx.columnMappingProfile.create({
        data: { ...fields, tenantId: ctx.tenantId, createdById: ctx.userId },
      });
    await audit(
      tx,
      ctx,
      id ? "MAPPING_PROFILE_UPDATED" : "MAPPING_PROFILE_CREATED",
      { type: "ColumnMappingProfile", id: saved.id },
      { name: saved.name },
    );
    return saved;
  });
}

export async function deleteMappingProfile(ctx: AuthContext, id: string) {
  requirePermission(ctx, "mapping:write");
  return withTenant(ctx.tenantId, async (tx) => {
    const p = await tx.columnMappingProfile.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!p) throw notFound("Mapping profile");
    await tx.columnMappingProfile.delete({ where: { id } });
    await audit(tx, ctx, "MAPPING_PROFILE_DELETED", { type: "ColumnMappingProfile", id }, { name: p.name });
  });
}
