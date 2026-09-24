import { prisma } from "../db";

/**
 * Fixed-window rate limiter backed by PostgreSQL, so limits hold across
 * multiple web/worker processes without extra infrastructure.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = new Date();
  const rows = await prisma.$queryRaw<{ count: number; windowStart: Date }[]>`
    INSERT INTO "rate_limit_buckets" ("key", "count", "windowStart")
    VALUES (${key}, 1, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" < ${new Date(now.getTime() - windowSeconds * 1000)}
                     THEN 1 ELSE "rate_limit_buckets"."count" + 1 END,
      "windowStart" = CASE WHEN "rate_limit_buckets"."windowStart" < ${new Date(now.getTime() - windowSeconds * 1000)}
                     THEN ${now} ELSE "rate_limit_buckets"."windowStart" END
    RETURNING "count", "windowStart"`;
  const row = rows[0]!;
  const count = Number(row.count);
  const resetAt = row.windowStart.getTime() + windowSeconds * 1000;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000)),
  };
}

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super("Too many requests. Please try again later.");
  }
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const result = await rateLimit(key, limit, windowSeconds);
  if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
}
