import { prisma } from "../db";

/** Platform-wide statistics for the super admin area (cross-tenant by design). */
export async function platformOverview() {
  const [orgsByStatus, users, documents, docsByStatus, connections, failedJobs, deadJobs, recentErrors, pendingOrgs] = await Promise.all([
    prisma.organization.groupBy({ by: ["status"], _count: true }),
    prisma.user.count(),
    prisma.document.count(),
    prisma.document.groupBy({ by: ["status"], _count: true }),
    prisma.zapierIntegration.count({ where: { enabled: true, webhookUrl: { not: null } } }),
    prisma.job.count({ where: { status: "PENDING", attempts: { gt: 0 } } }),
    prisma.job.count({ where: { status: "DEAD" } }),
    prisma.errorLog.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } }),
    prisma.organization.findMany({ where: { status: "PENDING_APPROVAL" }, orderBy: { submittedAt: "asc" }, take: 10 }),
  ]);
  return { orgsByStatus, users, documents, docsByStatus, connections, failedJobs, deadJobs, recentErrors, pendingOrgs };
}

export async function systemHealth() {
  const started = Date.now();
  let database = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = "error";
  }
  const dbLatencyMs = Date.now() - started;
  const [pendingJobs, oldestPending, runningJobs, deadJobs, failedEmails, failedWebhooks] = await Promise.all([
    prisma.job.count({ where: { status: "PENDING" } }),
    prisma.job.findFirst({ where: { status: "PENDING", runAt: { lte: new Date() } }, orderBy: { runAt: "asc" } }),
    prisma.job.count({ where: { status: "RUNNING" } }),
    prisma.job.findMany({ where: { status: "DEAD" }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.emailDelivery.count({ where: { status: "FAILED" } }),
    prisma.syncEvent.count({ where: { status: "FAILED" } }),
  ]);
  return {
    database,
    dbLatencyMs,
    pendingJobs,
    queueLagSeconds: oldestPending ? Math.round((Date.now() - oldestPending.runAt.getTime()) / 1000) : 0,
    runningJobs,
    deadJobs,
    failedEmails,
    failedSyncEvents: failedWebhooks,
  };
}
