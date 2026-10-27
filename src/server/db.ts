import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { config } from "./config";

export type Tx = Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as { __svsPrisma?: InstanceType<typeof PrismaClient> };

/**
 * Base client. Connects as the application role (row-level security applies).
 * Direct use is only appropriate for non-tenant tables (User, Session,
 * Membership, Tenant, JobQueue, RateLimitBucket, WorkerHeartbeat). Tenant data
 * MUST be accessed through withTenant(); otherwise RLS returns no rows.
 */
export function db() {
  if (!globalForPrisma.__svsPrisma) {
    const adapter = new PrismaPg({ connectionString: config().DATABASE_URL, max: 10 });
    globalForPrisma.__svsPrisma = new PrismaClient({
      adapter,
      transactionOptions: { maxWait: 10_000, timeout: 60_000 },
    });
  }
  return globalForPrisma.__svsPrisma;
}

/**
 * Run `fn` in a transaction whose row-level-security context is `tenantId`.
 * The setting is transaction-local, so pooled connections never leak it.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  if (!tenantId) throw new Error("withTenant requires a tenant id");
  return db().$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { timeout: opts.timeoutMs ?? 60_000, maxWait: 10_000 },
  );
}

export async function disconnectDb() {
  if (globalForPrisma.__svsPrisma) {
    await globalForPrisma.__svsPrisma.$disconnect();
    globalForPrisma.__svsPrisma = undefined;
  }
}
