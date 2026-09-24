import os from "node:os";
import type { Job } from "@prisma/client";
import { prisma } from "../db";
import { logError } from "../errors";
import type { JobType } from "./queue";

export type JobHandler = (payload: Record<string, unknown>, job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: JobType, handler: JobHandler) {
  handlers.set(type, handler);
}

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const STALE_LOCK_MS = 10 * 60 * 1000;

/** Claim and run up to `limit` due jobs. Safe to run concurrently in several processes. */
export async function processDueJobs(limit = 10): Promise<number> {
  await prisma.job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - STALE_LOCK_MS) } },
    data: { status: "PENDING", lockedAt: null, lockedBy: null },
  });

  const claimed = await prisma.$queryRaw<Job[]>`
    UPDATE "jobs" SET "status" = 'RUNNING', "lockedAt" = now(), "lockedBy" = ${WORKER_ID}, "attempts" = "attempts" + 1
    WHERE "id" IN (
      SELECT "id" FROM "jobs"
      WHERE "status" = 'PENDING' AND "runAt" <= now()
      ORDER BY "runAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;

  for (const job of claimed) {
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
      await handler((job.payload ?? {}) as Record<string, unknown>, job);
      await prisma.job.update({ where: { id: job.id }, data: { status: "COMPLETED", completedAt: new Date(), lockedAt: null, lastError: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const dead = job.attempts >= job.maxAttempts;
      // Exponential backoff: 30s, 2m, 8m, 32m …
      const delay = 30_000 * 4 ** Math.max(0, job.attempts - 1);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: dead ? "DEAD" : "PENDING",
          lastError: message.slice(0, 2000),
          lockedAt: null,
          lockedBy: null,
          runAt: dead ? undefined : new Date(Date.now() + delay),
        },
      });
      if (dead) await logError(error, { source: `job:${job.type}`, organizationId: job.organizationId, extra: { jobId: job.id } });
    }
  }
  return claimed.length;
}

/** Process until the queue is drained (used by tests and CLI). */
export async function drainJobs(maxRounds = 20): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const n = await processDueJobs(25);
    if (n === 0) return;
  }
}
