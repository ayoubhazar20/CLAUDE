import { prisma, type Tx } from "../db";
import { AppError } from "../errors";

/**
 * Billing-ready foundations. Payments are not active in V1, but plan limits and
 * usage are modelled so enforcement is data-driven (no hardcoded tiers).
 */
export type LimitKind = "users" | "documents" | "storage";

export const USAGE_METRICS = {
  DOCUMENT_CREATED: "DOCUMENT_CREATED",
  DOCUMENT_PUBLISHED: "DOCUMENT_PUBLISHED",
  EMAIL_SENT: "EMAIL_SENT",
  PDF_GENERATED: "PDF_GENERATED",
  STORAGE_BYTES: "STORAGE_BYTES",
} as const;

export function monthStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export async function activePlan(organizationId: string, tx: Tx = prisma) {
  const sub = await tx.subscription.findFirst({
    where: { organizationId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
  return sub?.plan ?? null;
}

export async function recordUsage(organizationId: string, metric: keyof typeof USAGE_METRICS, quantity = 1, metadata: Record<string, unknown> = {}, tx: Tx = prisma) {
  await tx.usageRecord.create({ data: { organizationId, metric, quantity, periodStart: monthStart(), metadata: metadata as object } });
}

export async function currentUsage(organizationId: string, tx: Tx = prisma) {
  const [users, documents, storage] = await Promise.all([
    tx.organizationMembership.count({ where: { organizationId, status: "ACTIVE" } }),
    tx.document.count({ where: { organizationId, createdAt: { gte: monthStart() } } }),
    tx.storedFile.aggregate({ where: { organizationId }, _sum: { size: true } }),
  ]);
  return { users, documentsThisMonth: documents, storageBytes: storage._sum.size ?? 0 };
}

export class PlanLimitError extends AppError {
  constructor(message: string) {
    super(message, 402, "PLAN_LIMIT_REACHED");
  }
}

export async function assertWithinLimit(organizationId: string, kind: LimitKind, extraBytes = 0, tx: Tx = prisma) {
  const plan = await activePlan(organizationId, tx);
  if (!plan) return; // No plan attached = unrestricted (e.g. during V1 without billing).
  const usage = await currentUsage(organizationId, tx);
  switch (kind) {
    case "users":
      if (plan.maxUsers !== null && usage.users >= plan.maxUsers) throw new PlanLimitError(`Your plan allows up to ${plan.maxUsers} users.`);
      break;
    case "documents":
      if (plan.maxDocumentsPerMonth !== null && usage.documentsThisMonth >= plan.maxDocumentsPerMonth)
        throw new PlanLimitError(`Your plan allows up to ${plan.maxDocumentsPerMonth} documents per month.`);
      break;
    case "storage":
      if (plan.maxStorageMb !== null && usage.storageBytes + extraBytes > plan.maxStorageMb * 1024 * 1024)
        throw new PlanLimitError(`Your plan includes ${plan.maxStorageMb} MB of storage.`);
      break;
  }
}

export async function hasFeature(organizationId: string, feature: string): Promise<boolean> {
  const plan = await activePlan(organizationId);
  return !plan || plan.features.includes(feature) || plan.features.includes("*");
}

/** Default plan catalogue (inserted by the seed / bootstrap script — editable by platform admins). */
export const DEFAULT_PLANS = [
  { key: "free", name: "Free", maxUsers: 3, maxDocumentsPerMonth: 25, maxStorageMb: 500, features: ["quotes", "contracts"], isDefault: false, sortOrder: 0 },
  { key: "starter", name: "Starter", maxUsers: 10, maxDocumentsPerMonth: 250, maxStorageMb: 5000, features: ["quotes", "contracts", "pipeline_automation"], isDefault: false, sortOrder: 1 },
  { key: "professional", name: "Professional", maxUsers: 50, maxDocumentsPerMonth: 2000, maxStorageMb: 25000, features: ["*"], isDefault: true, sortOrder: 2 },
  { key: "enterprise", name: "Enterprise", maxUsers: null, maxDocumentsPerMonth: null, maxStorageMb: null, features: ["*"], isDefault: false, sortOrder: 3 },
];

export async function ensureDefaultPlans(tx: Tx = prisma) {
  for (const p of DEFAULT_PLANS) {
    await tx.plan.upsert({ where: { key: p.key }, create: p, update: {} });
  }
}
