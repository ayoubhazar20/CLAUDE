/**
 * Create (or promote) a Platform Super Admin.
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... npx tsx scripts/create-platform-admin.ts
 */
import { prisma } from "../src/server/db";
import { hashPassword, passwordPolicyError } from "../src/server/security/password";
import { ensureSystemRoles } from "../src/server/services/roles";
import { ensureDefaultPlans } from "../src/server/services/billing";

async function main() {
  const email = (process.env.PLATFORM_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? "";
  if (!email || !password) throw new Error("Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD");
  const policy = passwordPolicyError(password);
  if (policy) throw new Error(policy);
  await ensureSystemRoles();
  await ensureDefaultPlans();
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name: "Platform Admin", passwordHash: await hashPassword(password), emailVerifiedAt: new Date(), isPlatformAdmin: true },
    update: { isPlatformAdmin: true },
  });
  console.info(`Platform admin ready: ${user.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
