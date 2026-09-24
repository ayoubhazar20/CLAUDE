import crypto from "node:crypto";
import { prisma } from "@/server/db";
import { buildOrgContext, type OrgContext } from "@/server/auth/context";
import { hashPassword } from "@/server/security/password";
import { createOrganization, approveOrganization } from "@/server/services/organizations";
import { clearRoleCache, systemRole } from "@/server/services/roles";
import { ensureDefaultPlans } from "@/server/services/billing";
import { drainJobs } from "@/server/jobs/runner";
import { registerAllJobHandlers } from "@/server/jobs/handlers";
import { LogEmailProvider, setEmailProvider } from "@/server/email/provider";
import type { SystemRoleKey } from "@/domain/permissions";

export const META = { ip: "203.0.113.10", userAgent: "Mozilla/5.0 (Test) Chrome/120" };

export async function resetDatabase() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  if (list) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  clearRoleCache();
  await ensureDefaultPlans();
}

export function useOutbox() {
  const provider = new LogEmailProvider();
  setEmailProvider(provider);
  return provider;
}

/**
 * Run all background jobs, fast-forwarding scheduled ones (e.g. Zapier deliveries
 * waiting for a PDF, or retries after a failure) so tests do not depend on wall time.
 */
export async function processJobs(rounds = 5) {
  registerAllJobHandlers();
  for (let i = 0; i < rounds; i++) {
    await drainJobs(50);
    const scheduled = await prisma.job.updateMany({ where: { status: "PENDING", runAt: { gt: new Date() } }, data: { runAt: new Date() } });
    if (scheduled.count === 0) return;
  }
}

export async function createUser(email: string, name = email.split("@")[0]!, opts: { verified?: boolean; platformAdmin?: boolean; password?: string } = {}) {
  return prisma.user.create({
    data: {
      email,
      name,
      passwordHash: await hashPassword(opts.password ?? "Sup3r-Secret!"),
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      isPlatformAdmin: Boolean(opts.platformAdmin),
    },
  });
}

let counter = 0;
export async function createActiveOrg(name = "Seller Inc") {
  counter += 1;
  const admin = await createUser(`admin${counter}-${crypto.randomUUID().slice(0, 6)}@seller.test`, "Alice Admin");
  const platform = await createUser(`platform${counter}-${crypto.randomUUID().slice(0, 6)}@dealdocs.test`, "Platform", { platformAdmin: true });
  const org = await createOrganization(
    admin.id,
    {
      name,
      country: "Morocco",
      addressLine1: "10 Boulevard Test",
      city: "Casablanca",
      defaultCurrency: "MAD",
      timezone: "Africa/Casablanca",
      language: "en",
      acceptTerms: true,
      acceptPrivacy: true,
    },
    META,
  );
  await approveOrganization(platform.id, org.id, META);
  const adminCtx = (await buildOrgContext({ userId: admin.id, organizationId: org.id, meta: META }))!;
  return { org, admin, adminCtx, platform };
}

export async function addMember(organizationId: string, role: SystemRoleKey, name: string): Promise<{ ctx: OrgContext; userId: string; membershipId: string }> {
  const user = await createUser(`${role}-${crypto.randomUUID().slice(0, 8)}@seller.test`, name);
  const r = await systemRole(role);
  const membership = await prisma.organizationMembership.create({ data: { organizationId, userId: user.id, roleId: r.id, status: "ACTIVE", joinedAt: new Date() } });
  const ctx = (await buildOrgContext({ userId: user.id, organizationId, meta: META }))!;
  return { ctx, userId: user.id, membershipId: membership.id };
}

export async function ctxFor(userId: string, organizationId: string) {
  return (await buildOrgContext({ userId, organizationId, meta: META }))!;
}

export async function templateId(organizationId: string, type: "QUOTE" | "CONTRACT") {
  const t = await prisma.template.findFirstOrThrow({ where: { organizationId, documentType: type, isDefault: true } });
  return t.id;
}

export function lastCode(outbox: LogEmailProvider, to: string): string {
  const mail = [...outbox.outbox].reverse().find((m) => m.to.includes(to) && /verification code/i.test(m.subject));
  if (!mail) throw new Error(`No OTP email for ${to}`);
  return mail.subject.match(/^(\d{6})/)![1]!;
}
