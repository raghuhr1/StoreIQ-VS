import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  CANONICAL_FIELDS,
  createRowMapper,
  DATE_FORMATS,
  readCsv,
  resolveProfile,
  resolveZoneValue,
  sniffCsv,
  suggestMapping,
  validateMapping,
  type CsvDelimiter,
  type FileContext,
  type ZoneRef,
} from "@/engine";
import type { Upload } from "@/generated/prisma/client";
import type { AuthContext } from "../auth/context";
import { requirePermission } from "../auth/context";
import { audit } from "../audit";
import { config } from "../config";
import { withTenant, type Tx } from "../db";
import { AppError, invalid, notFound } from "../errors";
import { objectKey, storage } from "../storage";
import { getStoreOrThrow } from "./stores";

const HEAD_BYTES = 64 * 1024;

export const fileMappingInput = z.object({
  mapping: z.partialRecord(z.enum(CANONICAL_FIELDS), z.string().min(1).max(200)),
  zoneValueMap: z.record(z.string().max(100), z.string().uuid()).default({}),
  dateFormat: z.enum(DATE_FORMATS).default("AUTO"),
});
export type FileMappingInput = z.infer<typeof fileMappingInput>;

export function sanitizeFilename(name: string) {
  const base = path
    .basename(name.replace(/\\/g, "/"))
    .replace(/[\x00-\x1f\x7f"<>|:*?]/g, "_")
    .trim();
  return base.slice(0, 200) || "upload.csv";
}

export function toZoneRefs(
  zones: { id: string; code: string; name: string; type: string; aliases: string[]; sortOrder: number }[],
): ZoneRef[] {
  return zones.map((z) => ({
    id: z.id,
    code: z.code,
    name: z.name,
    type: z.type as ZoneRef["type"],
    aliases: z.aliases,
    sortOrder: z.sortOrder,
  }));
}

interface IngestInput {
  storeId: string;
  filename: string;
  zoneId?: string | null;
  sessionLabel?: string | null;
  body: ReadableStream<Uint8Array> | Readable | null;
}

/**
 * Stream an uploaded scan export to a private temp file while enforcing the
 * size limit, hashing, and validating that the content is UTF-8 CSV text.
 * Only validated files reach object storage.
 */
export async function ingestUpload(ctx: AuthContext, input: IngestInput) {
  requirePermission(ctx, "upload:write");
  if (!input.body) throw invalid("Request body (the CSV file) is empty");
  const filename = sanitizeFilename(input.filename);
  if (!/\.(csv|txt)$/i.test(filename))
    throw new AppError(
      "UNSUPPORTED_FILE",
      "Only .csv (or .txt) scan exports are accepted. Export XLSX files as CSV.",
    );
  const sessionLabel = (input.sessionLabel?.trim() || filename.replace(/\.(csv|txt)$/i, "")).slice(0, 120);

  // Validate store/zone ownership before reading the body.
  await withTenant(ctx.tenantId, async (tx) => {
    await getStoreOrThrow(tx, ctx.tenantId, input.storeId);
    if (
      input.zoneId &&
      !(await tx.zone.findFirst({
        where: { id: input.zoneId, storeId: input.storeId, tenantId: ctx.tenantId },
      }))
    )
      throw notFound("Zone");
  });

  const max = config().MAX_UPLOAD_BYTES;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "svs-upload-"));
  const tmpFile = path.join(tmpDir, "file.csv");
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  const headChunks: Buffer[] = [];
  let headLen = 0;
  const inspector = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > max)
        return cb(
          new AppError("PAYLOAD_TOO_LARGE", `File exceeds the ${Math.round(max / 1048576)} MB limit`),
        );
      if (chunk.includes(0))
        return cb(
          new AppError("UNSUPPORTED_FILE", "The file contains binary data and is not a CSV text file"),
        );
      try {
        decoder.decode(chunk, { stream: true });
      } catch {
        return cb(
          new AppError("UNSUPPORTED_FILE", "The file is not valid UTF-8 text; save the export as UTF-8 CSV"),
        );
      }
      hash.update(chunk);
      if (headLen < HEAD_BYTES) {
        headChunks.push(chunk.subarray(0, HEAD_BYTES - headLen));
        headLen += Math.min(chunk.length, HEAD_BYTES - headLen);
      }
      cb(null, chunk);
    },
    flush(cb) {
      try {
        decoder.decode();
        cb();
      } catch {
        cb(new AppError("UNSUPPORTED_FILE", "The file ends with an incomplete UTF-8 character"));
      }
    },
  });

  try {
    const src =
      input.body instanceof Readable
        ? input.body
        : Readable.fromWeb(input.body as import("node:stream/web").ReadableStream);
    await pipeline(src, inspector, fs.createWriteStream(tmpFile, { mode: 0o600 }));
    const sniff = sniffCsv(Buffer.concat(headChunks));
    if (!sniff.ok) throw new AppError("UNSUPPORTED_FILE", sniff.message, { code: sniff.code });
    const sha256 = hash.digest("hex");
    const id = randomUUID();
    const key = objectKey("tenants", ctx.tenantId, "uploads", `${id}.csv`);
    await storage().putFile(key, tmpFile, "text/csv");

    return await withTenant(ctx.tenantId, async (tx) => {
      const duplicateOf = await tx.upload.findFirst({
        where: { tenantId: ctx.tenantId, storeId: input.storeId, sha256, status: { not: "REJECTED" } },
        select: { id: true, originalFilename: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const upload = await tx.upload.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          storeId: input.storeId,
          originalFilename: filename,
          storageKey: key,
          sizeBytes: size,
          sha256,
          encoding: sniff.sniff.encoding,
          hasBom: sniff.sniff.hasBom,
          delimiter: sniff.sniff.delimiter,
          lineEnding: sniff.sniff.lineEnding,
          zoneId: input.zoneId ?? null,
          sessionLabel,
          uploadedById: ctx.userId,
        },
      });
      await audit(
        tx,
        ctx,
        "UPLOAD_CREATED",
        { type: "Upload", id },
        { storeId: input.storeId, sizeBytes: size, sha256, duplicateOf: duplicateOf?.id ?? null },
      );
      return { upload: publicUpload(upload), duplicateOf };
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    if ((e as { code?: string }).code === "ERR_STREAM_PREMATURE_CLOSE")
      throw invalid("Upload was interrupted");
    throw e;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

export function publicUpload(u: Upload) {
  const { storageKey: _key, ...rest } = u;
  return rest;
}

export async function getUploadOrThrow(tx: Tx, tenantId: string, uploadId: string) {
  const u = await tx.upload.findFirst({ where: { id: uploadId, tenantId } });
  if (!u) throw notFound("Upload");
  return u;
}

export async function listUploads(ctx: AuthContext, q: { storeId?: string; limit: number; offset: number }) {
  requirePermission(ctx, "store:read");
  return withTenant(ctx.tenantId, async (tx) => {
    const where = { tenantId: ctx.tenantId, ...(q.storeId ? { storeId: q.storeId } : {}) };
    const [items, total] = await Promise.all([
      tx.upload.findMany({ where, orderBy: { createdAt: "desc" }, take: q.limit, skip: q.offset }),
      tx.upload.count({ where }),
    ]);
    return { items: items.map(publicUpload), total };
  });
}

async function openUpload(ctx: AuthContext, uploadId: string) {
  const { upload, store } = await withTenant(ctx.tenantId, async (tx) => {
    const upload = await getUploadOrThrow(tx, ctx.tenantId, uploadId);
    const store = await tx.store.findFirstOrThrow({
      where: { id: upload.storeId, tenantId: ctx.tenantId },
      include: { zones: { where: { active: true }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] } },
    });
    return { upload, store };
  });
  if (upload.fileDeletedAt)
    throw new AppError("CONFLICT", "The source file was removed by the retention policy");
  return { upload, store, zones: toZoneRefs(store.zones) };
}

/** Headers, sample rows and suggested mappings for the mapping step. */
export async function previewUpload(ctx: AuthContext, uploadId: string, sampleSize = 20) {
  requirePermission(ctx, "upload:write");
  const { upload, zones } = await openUpload(ctx, uploadId);
  let headers: string[] = [];
  let headerWarnings: string[] = [];
  const rows: string[][] = [];
  const malformed: { rowNumber: number; message: string }[] = [];
  for await (const item of readCsv(
    await storage().getStream(upload.storageKey),
    upload.delimiter as CsvDelimiter,
    { maxRecords: sampleSize },
  )) {
    if (item.kind === "header") ({ headers, warnings: headerWarnings } = item);
    else if (item.kind === "record") rows.push(item.record.slice(0, 200).map((c) => c.slice(0, 200)));
    else malformed.push({ rowNumber: item.rowNumber, message: item.message });
  }
  if (headers.length === 0) throw invalid("The file has no header row");
  const suggestion = suggestMapping(headers, rows);
  const savedProfiles = await withTenant(ctx.tenantId, (tx) =>
    tx.columnMappingProfile.findMany({
      where: { tenantId: ctx.tenantId, OR: [{ storeId: null }, { storeId: upload.storeId }] },
      orderBy: { updatedAt: "desc" },
    }),
  );
  const headerSet = new Set(headers);
  const matchingProfiles = savedProfiles
    .filter((p) => Object.values(p.mapping as Record<string, string>).every((c) => headerSet.has(c)))
    .map((p) => ({
      id: p.id,
      name: p.name,
      mapping: p.mapping,
      zoneValueMap: p.zoneValueMap,
      dateFormat: p.dateFormat,
      exportFormat: p.exportFormat,
    }));
  return {
    upload: publicUpload(upload),
    headers,
    headerWarnings,
    sampleRows: rows,
    malformed,
    suggestion,
    matchingProfiles,
    zones,
  };
}

export function buildFileContext(
  upload: Pick<Upload, "id" | "zoneId" | "sessionLabel" | "originalFilename">,
  timeZone: string,
  m: FileMappingInput,
): FileContext {
  return {
    uploadId: upload.id,
    mapping: m.mapping,
    fixedZoneId: upload.zoneId,
    sessionLabel: upload.sessionLabel ?? upload.originalFilename,
    zoneValueMap: m.zoneValueMap,
    dateFormat: m.dateFormat,
    timeZone,
  };
}

/**
 * Full validation pass of an upload against a mapping: row counts, error and
 * warning counts by code, zone values found, unique EPCs and a mapped preview.
 */
export async function validateUpload(ctx: AuthContext, uploadId: string, raw: unknown) {
  requirePermission(ctx, "upload:write");
  const m = fileMappingInput.parse(raw);
  const { upload, store, zones } = await openUpload(ctx, uploadId);
  const zoneIds = new Set(zones.map((z) => z.id));
  for (const zid of Object.values(m.zoneValueMap))
    if (!zoneIds.has(zid)) throw invalid("Zone value map refers to an unknown zone");
  const profile = await withTenant(ctx.tenantId, async (tx) => {
    const p = await tx.processingProfile.findFirst({
      where: { tenantId: ctx.tenantId, isDefault: true },
      orderBy: { version: "desc" },
    });
    return resolveProfile(p?.config ?? {});
  });

  const file = buildFileContext(upload, store.timeZone, m);
  let headers: string[] = [];
  let mapper: ReturnType<typeof createRowMapper> | null = null;
  let mappingCheck: ReturnType<typeof validateMapping> | null = null;
  let total = 0;
  let valid = 0;
  let invalidRows = 0;
  const issueCounts: Record<string, number> = {};
  const sampleIssues: { rowNumber: number; code: string; message: string; severity: string }[] = [];
  const zoneValues = new Map<string, number>();
  const epcs = new Set<string>();
  const preview: unknown[] = [];
  const maxRows = config().MAX_ROWS_PER_JOB;

  for await (const item of readCsv(
    await storage().getStream(upload.storageKey),
    upload.delimiter as CsvDelimiter,
  )) {
    if (item.kind === "header") {
      headers = item.headers;
      mappingCheck = validateMapping(m.mapping, headers, upload.zoneId);
      if (!mappingCheck.ok) break;
      mapper = createRowMapper(file, headers, zones, profile);
      continue;
    }
    total++;
    if (total > maxRows) throw invalid(`The file exceeds the ${maxRows.toLocaleString()} row limit`);
    if (item.kind === "malformed") {
      invalidRows++;
      issueCounts.MALFORMED_ROW = (issueCounts.MALFORMED_ROW ?? 0) + 1;
      if (sampleIssues.length < 50)
        sampleIssues.push({
          rowNumber: item.rowNumber,
          code: "MALFORMED_ROW",
          message: item.message,
          severity: "error",
        });
      continue;
    }
    const r = mapper!(item.record, item.rowNumber);
    for (const i of r.issues) {
      issueCounts[i.code] = (issueCounts[i.code] ?? 0) + 1;
      if (sampleIssues.length < 50)
        sampleIssues.push({ rowNumber: i.rowNumber, code: i.code, message: i.message, severity: i.severity });
    }
    if (m.mapping.zone) {
      const idx = headers.indexOf(m.mapping.zone);
      const zv = (item.record[idx] ?? "").trim().slice(0, 100);
      if (zoneValues.size < 200 || zoneValues.has(zv)) zoneValues.set(zv, (zoneValues.get(zv) ?? 0) + 1);
    }
    if (!r.observation) {
      invalidRows++;
      continue;
    }
    valid++;
    epcs.add(r.observation.epc);
    if (preview.length < 20) {
      const o = r.observation;
      preview.push({
        rowNumber: o.rowNumber,
        epc: o.epc,
        epcValid: o.epcValid,
        zone: zones.find((z) => z.id === o.zoneId)?.code,
        session: o.sessionExternalId,
        timestamp: o.timestamp === null ? null : new Date(o.timestamp).toISOString(),
        rssi: o.rssi,
        readCount: o.readCount,
      });
    }
  }
  if (!mappingCheck) throw invalid("The file has no header row");
  return {
    mapping: mappingCheck,
    totalRows: total,
    validRows: valid,
    invalidRows,
    uniqueEpcCount: epcs.size,
    issueCounts,
    sampleIssues,
    zoneValues: [...zoneValues.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({
        value,
        count,
        resolvedZoneId: resolveZoneValue(value, zones, m.zoneValueMap),
      })),
    preview,
    ok:
      mappingCheck.ok &&
      valid > 0 &&
      invalidRows / Math.max(1, total) <= profile.invalidRows.maxInvalidRowRatio,
  };
}
