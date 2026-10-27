import { z } from "zod";
import { isValidTimeZone, ZONE_TYPES } from "@/engine";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { audit } from "../audit";
import { withTenant, type Tx } from "../db";
import { AppError, notFound } from "../errors";

const code = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, _ or -");

export const storeInput = z.object({
  name: z.string().trim().min(1).max(120),
  code,
  timeZone: z.string().refine(isValidTimeZone, "Unknown IANA time zone").default("UTC"),
});

export const zoneInput = z.object({
  code: code.transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(80),
  type: z.enum(ZONE_TYPES),
  aliases: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  sortOrder: z.int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});

export const relationshipInput = z.object({
  fromZoneId: z.string().uuid(),
  toZoneId: z.string().uuid(),
  relation: z.enum(["ADJACENT", "DOORWAY", "SHARED_WALL", "SEPARATED"]),
  notes: z.string().max(200).optional(),
});

export const DEFAULT_ZONES = [
  { code: "SALES_FLOOR", name: "Sales Floor", type: "SALES_FLOOR" as const, aliases: ["SF"], sortOrder: 0 },
  { code: "BACK_ROOM", name: "Back Room", type: "BACK_ROOM" as const, aliases: ["BR"], sortOrder: 1 },
];

export async function getStoreOrThrow(tx: Tx, tenantId: string, storeId: string) {
  const store = await tx.store.findFirst({ where: { id: storeId, tenantId } });
  if (!store) throw notFound("Store");
  return store;
}

export async function listStores(ctx: AuthContext) {
  requirePermission(ctx, "store:read");
  return withTenant(ctx.tenantId, (tx) =>
    tx.store.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { name: "asc" },
      include: { zones: { orderBy: [{ sortOrder: "asc" }, { code: "asc" }] } },
    }),
  );
}

export async function getStore(ctx: AuthContext, storeId: string) {
  requirePermission(ctx, "store:read");
  return withTenant(ctx.tenantId, async (tx) => {
    const store = await tx.store.findFirst({
      where: { id: storeId, tenantId: ctx.tenantId },
      include: { zones: { orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }, relationships: true },
    });
    if (!store) throw notFound("Store");
    return store;
  });
}

export async function createStore(ctx: AuthContext, raw: unknown) {
  requirePermission(ctx, "store:write");
  const input = storeInput.parse(raw);
  return withTenant(ctx.tenantId, async (tx) => {
    if (await tx.store.findFirst({ where: { tenantId: ctx.tenantId, code: input.code } }))
      throw new AppError("CONFLICT", `Store code ${input.code} already exists`);
    const store = await tx.store.create({
      data: { ...input, tenantId: ctx.tenantId, zones: { create: DEFAULT_ZONES.map((z) => ({ ...z })) } },
      include: { zones: true },
    });
    await audit(tx, ctx, "STORE_CREATED", { type: "Store", id: store.id }, { code: store.code });
    return store;
  });
}

export async function updateStore(ctx: AuthContext, storeId: string, raw: unknown) {
  requirePermission(ctx, "store:write");
  const input = storeInput.partial().parse(raw);
  return withTenant(ctx.tenantId, async (tx) => {
    await getStoreOrThrow(tx, ctx.tenantId, storeId);
    const store = await tx.store.update({ where: { id: storeId }, data: input });
    await audit(tx, ctx, "STORE_UPDATED", { type: "Store", id: storeId }, { fields: Object.keys(input) });
    return store;
  });
}

export async function createZone(ctx: AuthContext, storeId: string, raw: unknown) {
  requirePermission(ctx, "store:write");
  const input = zoneInput.parse(raw);
  return withTenant(ctx.tenantId, async (tx) => {
    await getStoreOrThrow(tx, ctx.tenantId, storeId);
    if (await tx.zone.findFirst({ where: { storeId, code: input.code } }))
      throw new AppError("CONFLICT", `Zone ${input.code} already exists`);
    const zone = await tx.zone.create({ data: { ...input, storeId, tenantId: ctx.tenantId } });
    await audit(tx, ctx, "ZONE_CREATED", { type: "Zone", id: zone.id }, { storeId, code: zone.code });
    return zone;
  });
}

export async function updateZone(ctx: AuthContext, storeId: string, zoneId: string, raw: unknown) {
  requirePermission(ctx, "store:write");
  // Codes are referenced by exports and calibration settings; they stay fixed once created.
  const input = zoneInput.omit({ code: true }).partial().parse(raw);
  return withTenant(ctx.tenantId, async (tx) => {
    const zone = await tx.zone.findFirst({ where: { id: zoneId, storeId, tenantId: ctx.tenantId } });
    if (!zone) throw notFound("Zone");
    const updated = await tx.zone.update({ where: { id: zoneId }, data: input });
    await audit(tx, ctx, "ZONE_UPDATED", { type: "Zone", id: zoneId }, { fields: Object.keys(input) });
    return updated;
  });
}

export async function setRelationship(ctx: AuthContext, storeId: string, raw: unknown) {
  requirePermission(ctx, "store:write");
  const input = relationshipInput.parse(raw);
  if (input.fromZoneId === input.toZoneId)
    throw new AppError("VALIDATION_ERROR", "A zone cannot relate to itself");
  return withTenant(ctx.tenantId, async (tx) => {
    const zones = await tx.zone.count({
      where: { storeId, tenantId: ctx.tenantId, id: { in: [input.fromZoneId, input.toZoneId] } },
    });
    if (zones !== 2) throw notFound("Zone");
    const rel = await tx.zoneRelationship.upsert({
      where: {
        storeId_fromZoneId_toZoneId: { storeId, fromZoneId: input.fromZoneId, toZoneId: input.toZoneId },
      },
      create: { ...input, storeId, tenantId: ctx.tenantId },
      update: { relation: input.relation, notes: input.notes },
    });
    await audit(
      tx,
      ctx,
      "ZONE_RELATIONSHIP_SET",
      { type: "Store", id: storeId },
      { relation: input.relation },
    );
    return rel;
  });
}
