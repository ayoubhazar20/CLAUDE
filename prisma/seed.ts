/**
 * Development seed. Refuses to run in production.
 *
 * Creates: platform admin, "Demo Organization" (Admin, Manager, User, Viewer),
 * a HubSpot-like deal snapshot with products, quote & contract templates,
 * a draft quote, a published quote and a signed contract.
 */
import crypto from "node:crypto";
import { prisma } from "../src/server/db";
import { hashPassword } from "../src/server/security/password";
import { buildOrgContext } from "../src/server/auth/context";
import { ensureSystemRoles } from "../src/server/services/roles";
import { ensureDefaultPlans } from "../src/server/services/billing";
import { approveOrganization, createOrganization } from "../src/server/services/organizations";
import { createTeam, setTeamMember } from "../src/server/services/members";
import { createDocument, publishDocument, saveDraft } from "../src/server/documents/service";
import { requestActionCode, signDocument, verifyActionCode } from "../src/server/documents/signing";
import { drainJobs } from "../src/server/jobs/runner";
import { registerAllJobHandlers } from "../src/server/jobs/handlers";
import { LogEmailProvider, setEmailProvider } from "../src/server/email/provider";
import { parseDocumentData } from "../src/domain/document-data";

const PASSWORD = "DealDocs!2026";
const META = { ip: "127.0.0.1", userAgent: "seed" };

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed a production database.");
  if (await prisma.organization.findFirst({ where: { name: "Demo Organization" } })) {
    console.info("Seed data already present — nothing to do.");
    return;
  }
  const outbox = new LogEmailProvider();
  setEmailProvider(outbox);
  registerAllJobHandlers();
  const roles = await ensureSystemRoles();
  await ensureDefaultPlans();
  const hash = await hashPassword(PASSWORD);

  const platform = await prisma.user.upsert({
    where: { email: "platform@dealdocs.local" },
    create: { email: "platform@dealdocs.local", name: "Platform Admin", passwordHash: hash, emailVerifiedAt: new Date(), isPlatformAdmin: true },
    update: {},
  });
  const admin = await prisma.user.create({ data: { email: "admin@demo.local", name: "Alice Admin", passwordHash: hash, emailVerifiedAt: new Date() } });
  const org = await createOrganization(
    admin.id,
    {
      name: "Demo Organization",
      legalName: "Demo Organization SARL",
      country: "Morocco",
      addressLine1: "12 Boulevard d'Anfa",
      city: "Casablanca",
      postalCode: "20000",
      defaultCurrency: "MAD",
      timezone: "Africa/Casablanca",
      language: "en",
      vatNumber: "MA-12345678",
      registrationNumber: "RC 123456",
      phone: "+212 522 000 000",
      website: "demo.local",
      acceptTerms: true,
      acceptPrivacy: true,
    },
    META,
  );
  await approveOrganization(platform.id, org.id, META);
  await prisma.organization.update({ where: { id: org.id }, data: { onboardingCompletedAt: new Date(), onboardingState: { profile: "done", ready: "done" } } });

  const members: Record<string, { id: string; membershipId: string }> = {};
  for (const [key, email, name] of [
    ["manager", "manager@demo.local", "Mark Manager"],
    ["user", "user@demo.local", "Ursula User"],
    ["viewer", "viewer@demo.local", "Victor Viewer"],
  ] as const) {
    const u = await prisma.user.create({ data: { email, name, passwordHash: hash, emailVerifiedAt: new Date() } });
    const m = await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: u.id, roleId: roles[key].id, status: "ACTIVE", joinedAt: new Date() } });
    members[key] = { id: u.id, membershipId: m.id };
  }
  const adminCtx = (await buildOrgContext({ userId: admin.id, organizationId: org.id, meta: META }))!;
  const team = await createTeam(adminCtx, "Sales");
  await setTeamMember(adminCtx, team.id, members.manager!.membershipId, true, true);
  await setTeamMember(adminCtx, team.id, members.user!.membershipId, true);

  await prisma.customFieldDefinition.createMany({
    data: [
      { organizationId: org.id, key: "payment.terms", label: "Payment terms", type: "TEXT", defaultValue: "30 days net", appliesTo: ["QUOTE", "CONTRACT"] },
      { organizationId: org.id, key: "warranty.period", label: "Warranty period", type: "TEXT", defaultValue: "12 months", appliesTo: ["CONTRACT"] },
      { organizationId: org.id, key: "project.startDate", label: "Project start date", type: "DATE", appliesTo: ["QUOTE", "CONTRACT"] },
    ],
  });

  const quoteTemplate = await prisma.template.findFirstOrThrow({ where: { organizationId: org.id, documentType: "QUOTE" } });
  const contractTemplate = await prisma.template.findFirstOrThrow({ where: { organizationId: org.id, documentType: "CONTRACT" } });

  // HubSpot-like deal snapshot (no live HubSpot needed in development).
  const dealData = (versionData: unknown) => {
    const d = parseDocumentData(versionData);
    d.contact = { hubspotId: "501", firstName: "Amina", lastName: "Benali", email: "amina@client.example", phone: "+212 600 111 222", jobTitle: "Operations Director" };
    d.company = { hubspotId: "601", name: "Atlas Logistics", address: "45 Rue Ibn Batouta", city: "Rabat", zip: "10000", country: "Morocco", phone: "", domain: "atlas.example" };
    d.deal = { hubspotId: "9001", name: "Atlas — Fleet tracking rollout", amount: "18500", pipeline: "Sales Pipeline", pipelineId: "default", stage: "Proposal", stageId: "presentationscheduled", closeDate: "2026-12-15", owner: { hubspotId: "77", name: "Alice Admin", email: "admin@demo.local" } };
    d.recipients = [{ id: crypto.randomUUID(), name: "Amina Benali", email: "amina@client.example", role: "SIGNER", signingOrder: 1, required: true, hubspotContactId: "501" }];
    d.customFields = { "payment.terms": "30 days net", "warranty.period": "12 months" };
    return d;
  };
  const products = () => [
    { id: crypto.randomUUID(), source: "HUBSPOT_LINE_ITEM" as const, hubspotLineItemId: "701", sku: "TRK-100", name: "GPS tracker", description: "4G tracker with 2-year battery", category: "Hardware", quantity: "25", unitPrice: "450", discountType: "PERCENT" as const, discountValue: "5", taxKeys: ["vat"] },
    { id: crypto.randomUUID(), source: "HUBSPOT_LINE_ITEM" as const, hubspotLineItemId: "702", sku: "SAAS-Y", name: "Fleet platform — annual license", description: null, category: "Software", quantity: "1", unitPrice: "6000", discountType: "NONE" as const, discountValue: "0", taxKeys: ["vat"] },
    { id: crypto.randomUUID(), source: "CUSTOM" as const, name: "Installation & training", description: "On-site, 2 days", category: "Consulting", quantity: "2", unitPrice: "1200", discountType: "NONE" as const, discountValue: "0", taxKeys: ["vat"] },
  ];
  const pricing = { globalDiscountType: "NONE" as const, globalDiscountValue: "0", taxes: [{ key: "vat", name: "VAT", rate: "20" }], fees: [] };

  async function makeDoc(ctx: typeof adminCtx, type: "QUOTE" | "CONTRACT", templateId: string, title: string) {
    // Zapier is not configured in the demo, so no deal data is requested — the snapshot is written directly.
    const doc = await createDocument(ctx, { type, templateId, hubspotDealId: "9001" });
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.draftVersionId! } });
    await prisma.document.update({ where: { id: doc.id }, data: { hubspotDealName: "Atlas — Fleet tracking rollout" } });
    await saveDraft(ctx, doc.id, { baseUpdatedAt: version.updatedAt.toISOString(), title, data: dealData(version.data), pricingConfig: pricing, lineItems: products() });
    return doc;
  }

  const userCtx = (await buildOrgContext({ userId: members.user!.id, organizationId: org.id, meta: META }))!;
  await makeDoc(userCtx, "QUOTE", quoteTemplate.id, "Fleet tracking — draft proposal");
  const published = await makeDoc(adminCtx, "QUOTE", quoteTemplate.id, "Fleet tracking proposal");
  await publishDocument(adminCtx, published.id);

  const contract = await makeDoc(adminCtx, "CONTRACT", contractTemplate.id, "Fleet tracking service agreement");
  await publishDocument(adminCtx, contract.id);
  const c = await prisma.document.findUniqueOrThrow({ where: { id: contract.id } });
  const recipient = await prisma.documentRecipient.findFirstOrThrow({ where: { documentId: c.id } });
  const { challengeId } = await requestActionCode(c.publicToken, { recipientId: recipient.id, action: "SIGN_CONTRACT" }, META);
  await drainJobs();
  const code = outbox.outbox.map((m) => m.subject.match(/^(\d{6}) is your verification code/)?.[1]).filter(Boolean).pop()!;
  const { grant } = await verifyActionCode(c.publicToken, { challengeId, code }, { ...META, userAgent: "Mozilla/5.0 (seed)" });
  await signDocument(c.publicToken, { grant, signerName: "Amina Benali", method: "TYPED", signatureData: "Amina Benali", consent: true }, { ...META, userAgent: "Mozilla/5.0 (seed)" });
  await drainJobs();

  console.info(`
Seed complete. All passwords: ${PASSWORD}
  Platform admin : platform@dealdocs.local
  Company admin  : admin@demo.local
  Manager        : manager@demo.local
  User           : user@demo.local
  Viewer         : viewer@demo.local
  Published quote: /d/${(await prisma.document.findUniqueOrThrow({ where: { id: published.id } })).publicToken}
  Signed contract: /d/${c.publicToken}
`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
