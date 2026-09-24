import type { Prisma } from "@prisma/client";
import { prisma, type Tx } from "../db";

/**
 * Queue abstraction. Jobs are persisted in PostgreSQL (no extra infrastructure
 * needed on Hostinger); the runner can later be swapped for Redis/SQS without
 * touching business logic, which only calls `enqueue`.
 */
export type JobType =
  | "email.send"
  | "pdf.generate"
  | "pdf.generateSigned"
  | "zapier.deliver"
  | "notifications.email"
  | "documents.expireDue";

export interface EnqueueOptions {
  organizationId?: string | null;
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}

type Kick = () => void;
let kick: Kick | null = null;
/** The inline runner registers a callback to process new jobs immediately. */
export function registerQueueKick(fn: Kick) {
  kick = fn;
}

export async function enqueue(type: JobType, payload: Record<string, unknown>, options: EnqueueOptions = {}, tx: Tx = prisma) {
  const data: Prisma.JobCreateInput = {
    type,
    payload: payload as Prisma.InputJsonValue,
    organizationId: options.organizationId ?? null,
    runAt: options.runAt ?? new Date(),
    maxAttempts: options.maxAttempts ?? 5,
    dedupeKey: options.dedupeKey ?? null,
  };
  const job = options.dedupeKey
    ? await tx.job.upsert({ where: { dedupeKey: options.dedupeKey }, create: data, update: {} })
    : await tx.job.create({ data });
  // Transactions: the kick is harmless if it runs before commit (job not yet visible → picked up by poll).
  if (kick) setTimeout(kick, 50);
  return job;
}
