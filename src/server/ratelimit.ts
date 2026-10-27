import { db } from "./db";
import { AppError } from "./errors";

/** Fixed-window rate limit shared across instances (stored in PostgreSQL). */
export async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const rows = await db().$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "windowStart") VALUES (${key}, 1, now())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."windowStart" < now() - make_interval(secs => ${windowSeconds}) THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
      "windowStart" = CASE WHEN "RateLimitBucket"."windowStart" < now() - make_interval(secs => ${windowSeconds}) THEN now() ELSE "RateLimitBucket"."windowStart" END
    RETURNING "count"`;
  if (rows[0].count > limit)
    throw new AppError("RATE_LIMITED", "Too many requests; please wait and try again");
}
