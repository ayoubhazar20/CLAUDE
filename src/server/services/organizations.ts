import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, type Tx } from "../db";
import { appUrl, env } from "../env";
import { audit } from "../audit";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { RequestMeta } from "../request";
import { queueEmail } from "../email/service";
import { renderEmailLayout, textToEmailHtml } from "../email/layout";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { systemRole } from "./roles";
import { DEFAULT_EMAIL_TEMPLATES, starterContractBlocks, starterQuoteBlocks } from "./starter-content";
import { CURRENCY_CODES } from "@/domain/currencies";
import { DEFAULT_NUMBERING } from "@/domain/numbering";
import { PERMISSIONS } from "@/domain/permissions";

const timezoneSchema = z.string().max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown timezone");

export const companyProfileSchema = z.object({
  name: z.string().trim().min(2).max(160),
  legalName: z.string().trim().max(200).optional().default(""),
  country: z.string().trim().min(2).max(80),
  addressLine1: z.string().trim().min(2).max(200),
  addressLine2: z.string().trim().max(200).optional().default(""),
  city: z.string().trim().max(120).optional().default(""),
  postalCode: z.string().trim().max(32).optional().default(""),
  region: z.string().trim().max(120).optional().default(""),
  phone: z.string().trim().max(64).optional().default(""),
  website: z.string().trim().max(200).optional().default(""),
  defaultCurrency: z.enum(CURRENCY_CODES as [string, ...string[]]),
  timezone: timezoneSchema,
  language: z.enum(["en"]).default("en"),
  registrationNumber: z.string().trim().max(120).optional().default(""),
  vatNumber: z.string().trim().max(120).optional().default(""),
});

export const createCompanySchema = companyProfileSchema.extend({
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms of Service" }) }),
  acceptPrivacy: z.literal(true, { errorMap: () => ({ message: "You must accept the Privacy Policy" }) }),
});

const emptyToNull = (v: string | undefined) => (v && v.length ? v : null);

/** Provision per-organization defaults (numbering, email templates, starter templates, plan). */
export async function provisionOrganizationDefaults(organizationId: string, userId: string | null, tx: Tx) {
  for (const type of ["QUOTE", "CONTRACT"] as const) {
    const d = DEFAULT_NUMBERING[type];
    await tx.numberingSetting.upsert({
      where: { organizationId_documentType: { organizationId, documentType: type } },
      create: { organizationId, documentType: type, prefix: d.prefix, includeYear: d.includeYear, padding: d.padding, startNumber: d.startNumber },
      update: {},
    });
  }
  const existingEmail = await tx.emailTemplate.count({ where: { organizationId } });
  if (existingEmail === 0) {
    await tx.emailTemplate.createMany({
      data: Object.entries(DEFAULT_EMAIL_TEMPLATES).map(([kind, t]) => ({
        organizationId,
        kind: kind as keyof typeof DEFAULT_EMAIL_TEMPLATES,
        name: t.name,
        subject: t.subject,
        body: t.body,
        isDefault: true,
      })),
    });
  }
  const existingTemplates = await tx.template.count({ where: { organizationId } });
  if (existingTemplates === 0) {
    const starters = [
      { type: "QUOTE" as const, name: "Standard Quote", blocks: starterQuoteBlocks(), settings: { acceptanceMode: "ACCEPTANCE_ONLY", expirationDays: 30 } },
      { type: "CONTRACT" as const, name: "Service Agreement", blocks: starterContractBlocks(), settings: { acceptanceMode: "SIGNATURE_REQUIRED", expirationDays: 30, signingOrder: "ANY" } },
    ];
    for (const s of starters) {
      const template = await tx.template.create({
        data: { organizationId, documentType: s.type, name: s.name, description: "Starter template", isDefault: true, createdById: userId },
      });
      const version = await tx.templateVersion.create({
        data: {
          organizationId,
          templateId: template.id,
          version: 1,
          status: "PUBLISHED",
          content: s.blocks as unknown as Prisma.InputJsonValue,
          settings: s.settings,
          createdById: userId,
          publishedAt: new Date(),
          publishedById: userId,
        },
      });
      await tx.template.update({ where: { id: template.id }, data: { publishedVersionId: version.id } });
    }
  }
  const hasSubscription = await tx.subscription.count({ where: { organizationId } });
  if (!hasSubscription) {
    const plan = await tx.plan.findFirst({ where: { isDefault: true, isActive: true } });
    if (plan) await tx.subscription.create({ data: { organizationId, planId: plan.id, status: "TRIALING" } });
  }
}

/** Step "Create Company": creates the organization in PENDING_APPROVAL with the user as Company Admin. */
export async function createOrganization(userId: string, input: z.input<typeof createCompanySchema>, meta: RequestMeta) {
  const data = createCompanySchema.parse(input);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User");
  if (!user.emailVerifiedAt) throw new AppError("Please verify your email address first.", 403, "EMAIL_NOT_VERIFIED");
  const existing = await prisma.organizationMembership.count({ where: { userId, status: { in: ["ACTIVE", "INVITED"] } } });
  if (existing > 0) throw new ConflictError("You already belong to an organization.");

  const adminRole = await systemRole("admin");
  const now = new Date();
  const org = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: data.name,
        legalName: emptyToNull(data.legalName),
        country: data.country,
        addressLine1: data.addressLine1,
        addressLine2: emptyToNull(data.addressLine2),
        city: emptyToNull(data.city),
        postalCode: emptyToNull(data.postalCode),
        region: emptyToNull(data.region),
        phone: emptyToNull(data.phone),
        website: emptyToNull(data.website),
        defaultCurrency: data.defaultCurrency,
        timezone: data.timezone,
        language: data.language,
        registrationNumber: emptyToNull(data.registrationNumber),
        vatNumber: emptyToNull(data.vatNumber),
        status: "PENDING_APPROVAL",
        submittedAt: now,
        createdById: userId,
      },
    });
    await tx.organizationMembership.create({
      data: { organizationId: org.id, userId, roleId: adminRole.id, status: "ACTIVE", joinedAt: now },
    });
    await tx.termsAcceptance.createMany({
      data: [
        { userId, organizationId: org.id, documentType: "TERMS_OF_SERVICE", version: env().TERMS_VERSION, acceptedAt: now, ip: meta.ip, userAgent: meta.userAgent },
        { userId, organizationId: org.id, documentType: "PRIVACY_POLICY", version: env().PRIVACY_VERSION, acceptedAt: now, ip: meta.ip, userAgent: meta.userAgent },
      ],
    });
    await provisionOrganizationDefaults(org.id, userId, tx);
    await audit({ organizationId: org.id, userId, action: "ORGANIZATION_CREATED", entityType: "Organization", entityId: org.id, ip: meta.ip, userAgent: meta.userAgent, newValue: { name: org.name } }, tx);
    await audit({ organizationId: org.id, userId, action: "TERMS_ACCEPTED", entityType: "Organization", entityId: org.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { terms: env().TERMS_VERSION, privacy: env().PRIVACY_VERSION } }, tx);
    await audit({ organizationId: org.id, userId, action: "ORGANIZATION_SUBMITTED", entityType: "Organization", entityId: org.id, ip: meta.ip, userAgent: meta.userAgent }, tx);
    return org;
  });

  const admins = await prisma.user.findMany({ where: { isPlatformAdmin: true, status: "ACTIVE" }, select: { email: true } });
  if (admins.length) {
    await queueEmail({
      kind: "PLATFORM_ORG_PENDING",
      to: admins.map((a) => a.email),
      subject: `New organization pending approval: ${org.name}`,
      html: renderEmailLayout({
        brandName: "DealDocs Platform",
        bodyHtml: textToEmailHtml(`${org.name} (${org.country}) was registered by ${user.name} <${user.email}> and is awaiting review.`),
        action: { label: "Review organization", url: appUrl(`/admin/organizations/${org.id}`) },
      }),
    });
  }
  return org;
}

// ───────────────────────── Platform admin lifecycle ─────────────────────────

async function notifyOrgAdmins(organizationId: string, subject: string, body: string, action?: { label: string; url: string }) {
  const admins = await prisma.organizationMembership.findMany({
    where: { organizationId, status: "ACTIVE", role: { key: "admin" } },
    include: { user: true },
  });
  if (!admins.length) return;
  await queueEmail({
    organizationId,
    kind: "ORGANIZATION_STATUS",
    to: admins.map((a) => a.user.email),
    subject,
    html: renderEmailLayout({ brandName: "DealDocs", bodyHtml: textToEmailHtml(body), action }),
  });
}

async function loadOrgForAdmin(id: string) {
  const org = await prisma.organization.findUnique({ where: { id } });
  if (!org) throw new NotFoundError("Organization");
  return org;
}

export async function approveOrganization(adminUserId: string, organizationId: string, meta: RequestMeta) {
  const org = await loadOrgForAdmin(organizationId);
  if (org.status !== "PENDING_APPROVAL" && org.status !== "REJECTED") throw new ConflictError("Only pending organizations can be approved.");
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { status: "ACTIVE", approvedAt: new Date(), approvedById: adminUserId, rejectedAt: null, rejectionReason: null } });
    await provisionOrganizationDefaults(org.id, null, tx);
    await audit({ organizationId: org.id, userId: adminUserId, actorType: "PLATFORM_ADMIN", action: "ORGANIZATION_APPROVED", entityType: "Organization", entityId: org.id, ip: meta.ip, userAgent: meta.userAgent, previousValue: { status: org.status }, newValue: { status: "ACTIVE" } }, tx);
  });
  await notifyOrgAdmins(org.id, "Your DealDocs account has been approved", `Good news — ${org.name} has been approved. You can now sign in and complete the setup wizard.`, { label: "Get started", url: appUrl("/onboarding") });
}

export async function rejectOrganization(adminUserId: string, organizationId: string, reason: string, meta: RequestMeta) {
  const org = await loadOrgForAdmin(organizationId);
  if (org.status !== "PENDING_APPROVAL") throw new ConflictError("Only pending organizations can be rejected.");
  const cleanReason = reason.trim().slice(0, 1000);
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { status: "REJECTED", rejectedAt: new Date(), rejectionReason: cleanReason || null } });
    await audit({ organizationId: org.id, userId: adminUserId, actorType: "PLATFORM_ADMIN", action: "ORGANIZATION_REJECTED", entityType: "Organization", entityId: org.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { reason: cleanReason } }, tx);
  });
  await notifyOrgAdmins(org.id, "Your DealDocs registration", `We were unable to approve ${org.name} at this time.${cleanReason ? `\n\nReason: ${cleanReason}` : ""}`);
}

export async function suspendOrganization(adminUserId: string, organizationId: string, reason: string, meta: RequestMeta) {
  const org = await loadOrgForAdmin(organizationId);
  if (org.status !== "ACTIVE") throw new ConflictError("Only active organizations can be suspended.");
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: reason.slice(0, 1000) || null } });
    await audit({ organizationId: org.id, userId: adminUserId, actorType: "PLATFORM_ADMIN", action: "ORGANIZATION_SUSPENDED", entityType: "Organization", entityId: org.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { reason } }, tx);
  });
}

export async function reactivateOrganization(adminUserId: string, organizationId: string, meta: RequestMeta) {
  const org = await loadOrgForAdmin(organizationId);
  if (org.status !== "SUSPENDED") throw new ConflictError("Only suspended organizations can be reactivated.");
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: org.id }, data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null } });
    await audit({ organizationId: org.id, userId: adminUserId, actorType: "PLATFORM_ADMIN", action: "ORGANIZATION_REACTIVATED", entityType: "Organization", entityId: org.id, ip: meta.ip, userAgent: meta.userAgent }, tx);
  });
}

/** Platform support view: read-only access into a tenant, always audited. */
export async function openSupportView(adminUserId: string, sessionId: string, organizationId: string, meta: RequestMeta) {
  const org = await loadOrgForAdmin(organizationId);
  const admin = await prisma.user.findUnique({ where: { id: adminUserId } });
  if (!admin?.isPlatformAdmin) throw new ForbiddenError();
  await prisma.session.update({ where: { id: sessionId }, data: { supportOrganizationId: org.id } });
  await audit({ organizationId: org.id, userId: adminUserId, actorType: "PLATFORM_ADMIN", action: "SUPPORT_VIEW_OPENED", entityType: "Organization", entityId: org.id, ip: meta.ip, userAgent: meta.userAgent });
}

export async function closeSupportView(adminUserId: string, sessionId: string, meta: RequestMeta) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session?.supportOrganizationId) return;
  await prisma.session.update({ where: { id: sessionId }, data: { supportOrganizationId: null } });
  await audit({ organizationId: session.supportOrganizationId, userId: adminUserId, actorType: "PLATFORM_ADMIN", action: "SUPPORT_VIEW_CLOSED", entityType: "Organization", entityId: session.supportOrganizationId, ip: meta.ip, userAgent: meta.userAgent });
}

// ───────────────────────── Tenant self-service ─────────────────────────

export const brandingSchema = z.object({
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #2563eb"),
});

export async function updateCompanyProfile(ctx: OrgContext, input: z.input<typeof companyProfileSchema>) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.ORG_SETTINGS_MANAGE);
  const data = companyProfileSchema.parse(input);
  const before = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const updated = await prisma.organization.update({
    where: { id: ctx.organizationId },
    data: {
      name: data.name,
      legalName: emptyToNull(data.legalName),
      country: data.country,
      addressLine1: data.addressLine1,
      addressLine2: emptyToNull(data.addressLine2),
      city: emptyToNull(data.city),
      postalCode: emptyToNull(data.postalCode),
      region: emptyToNull(data.region),
      phone: emptyToNull(data.phone),
      website: emptyToNull(data.website),
      defaultCurrency: data.defaultCurrency,
      timezone: data.timezone,
      language: data.language,
      registrationNumber: emptyToNull(data.registrationNumber),
      vatNumber: emptyToNull(data.vatNumber),
    },
  });
  await audit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: "ORGANIZATION_UPDATED",
    entityType: "Organization",
    entityId: ctx.organizationId,
    ip: ctx.meta.ip,
    userAgent: ctx.meta.userAgent,
    previousValue: { name: before.name, defaultCurrency: before.defaultCurrency, timezone: before.timezone },
    newValue: { name: updated.name, defaultCurrency: updated.defaultCurrency, timezone: updated.timezone },
  });
  return updated;
}

export async function updateBranding(ctx: OrgContext, input: { brandColor: string; logoFileId?: string | null }) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.ORG_SETTINGS_MANAGE);
  const { brandColor } = brandingSchema.parse(input);
  if (input.logoFileId) {
    const file = await prisma.storedFile.findFirst({ where: { id: input.logoFileId, organizationId: ctx.organizationId, kind: "LOGO" } });
    if (!file) throw new ValidationError("Invalid logo file");
  }
  await prisma.organization.update({
    where: { id: ctx.organizationId },
    data: { brandColor, ...(input.logoFileId !== undefined ? { logoFileId: input.logoFileId } : {}) },
  });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "ORGANIZATION_UPDATED", entityType: "Organization", entityId: ctx.organizationId, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, newValue: { brandColor, logoChanged: input.logoFileId !== undefined } });
}

export const ONBOARDING_STEPS = ["profile", "branding", "hubspot", "currency", "pipeline", "templates", "team", "ready"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export async function updateOnboarding(ctx: OrgContext, step: OnboardingStep, status: "done" | "skipped") {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.ORG_SETTINGS_MANAGE);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const state = { ...((org.onboardingState as Record<string, string>) ?? {}), [step]: status };
  await prisma.organization.update({
    where: { id: ctx.organizationId },
    data: { onboardingState: state, ...(step === "ready" ? { onboardingCompletedAt: new Date() } : {}) },
  });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "ONBOARDING_UPDATED", entityType: "Organization", entityId: ctx.organizationId, metadata: { step, status } });
}

export async function updateNumbering(ctx: OrgContext, input: { documentType: "QUOTE" | "CONTRACT"; prefix: string; includeYear: boolean; startNumber: number; padding: number }) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.ORG_SETTINGS_MANAGE);
  const data = z
    .object({
      documentType: z.enum(["QUOTE", "CONTRACT"]),
      prefix: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9_]+$/, "Letters, digits and underscore only"),
      includeYear: z.boolean(),
      startNumber: z.number().int().min(1).max(1_000_000_000),
      padding: z.number().int().min(1).max(12),
    })
    .parse(input);
  const before = await prisma.numberingSetting.findUnique({ where: { organizationId_documentType: { organizationId: ctx.organizationId, documentType: data.documentType } } });
  await prisma.numberingSetting.upsert({
    where: { organizationId_documentType: { organizationId: ctx.organizationId, documentType: data.documentType } },
    create: { organizationId: ctx.organizationId, ...data },
    update: { prefix: data.prefix, includeYear: data.includeYear, startNumber: data.startNumber, padding: data.padding },
  });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "NUMBERING_UPDATED", entityType: "NumberingSetting", entityId: data.documentType, previousValue: before, newValue: data });
}
