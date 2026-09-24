import type { Organization, OrganizationStatus } from "@prisma/client";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { cache } from "react";
import { prisma } from "../db";
import { ForbiddenError, UnauthorizedError } from "../errors";
import { requestMeta, type RequestMeta } from "../request";
import { getSessionFromCookies } from "./session";
import { PERMISSIONS, type Permission } from "@/domain/permissions";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  emailVerified: boolean;
}

/** Tenant-scoped request context. Every service call on tenant data receives one. */
export interface OrgContext {
  user: SessionUser;
  sessionId: string | null;
  organizationId: string;
  organization: Pick<Organization, "id" | "name" | "status" | "timezone" | "defaultCurrency" | "language" | "onboardingCompletedAt" | "brandColor" | "logoFileId">;
  membershipId: string | null;
  roleKey: string;
  permissions: ReadonlySet<string>;
  /** Platform admin read-only support session. */
  isSupportView: boolean;
  meta: RequestMeta;
}

/** Permissions granted in a (read-only) platform support view. */
const SUPPORT_VIEW_PERMISSIONS: Permission[] = [
  PERMISSIONS.DOCUMENTS_VIEW_ALL,
  PERMISSIONS.TEMPLATES_VIEW,
  PERMISSIONS.USERS_VIEW,
  PERMISSIONS.ANALYTICS_VIEW_ALL,
  PERMISSIONS.AUDIT_VIEW,
  PERMISSIONS.BILLING_VIEW,
];

const loadSession = cache(async () => getSessionFromCookies());

export const getCurrentUser = cache(async (): Promise<(SessionUser & { sessionId: string }) | null> => {
  const session = await loadSession();
  if (!session) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    isPlatformAdmin: session.user.isPlatformAdmin,
    emailVerified: Boolean(session.user.emailVerifiedAt),
    sessionId: session.id,
  };
});

/** Build an OrgContext for (user, organization) — also used by tests and jobs. */
export async function buildOrgContext(params: {
  userId: string;
  organizationId: string;
  sessionId?: string | null;
  meta?: RequestMeta;
  supportView?: boolean;
}): Promise<OrgContext | null> {
  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user || user.status !== "ACTIVE") return null;
  const organization = await prisma.organization.findUnique({ where: { id: params.organizationId } });
  if (!organization) return null;

  const sessionUser: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    isPlatformAdmin: user.isPlatformAdmin,
    emailVerified: Boolean(user.emailVerifiedAt),
  };
  const orgSummary = {
    id: organization.id,
    name: organization.name,
    status: organization.status,
    timezone: organization.timezone,
    defaultCurrency: organization.defaultCurrency,
    language: organization.language,
    onboardingCompletedAt: organization.onboardingCompletedAt,
    brandColor: organization.brandColor,
    logoFileId: organization.logoFileId,
  };

  if (params.supportView) {
    if (!user.isPlatformAdmin) return null;
    return {
      user: sessionUser,
      sessionId: params.sessionId ?? null,
      organizationId: organization.id,
      organization: orgSummary,
      membershipId: null,
      roleKey: "platform_support",
      permissions: new Set(SUPPORT_VIEW_PERMISSIONS),
      isSupportView: true,
      meta: params.meta ?? { ip: null, userAgent: null },
    };
  }

  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
    include: { role: { include: { permissions: true } } },
  });
  if (!membership || membership.status !== "ACTIVE") return null;
  return {
    user: sessionUser,
    sessionId: params.sessionId ?? null,
    organizationId: organization.id,
    organization: orgSummary,
    membershipId: membership.id,
    roleKey: membership.role.key,
    permissions: new Set(membership.role.permissions.map((p) => p.permission)),
    isSupportView: false,
    meta: params.meta ?? { ip: null, userAgent: null },
  };
}

/** Resolve the org context for the current request (null if not signed in / no membership). */
export const getOrgContext = cache(async (): Promise<OrgContext | null> => {
  const session = await loadSession();
  if (!session) return null;
  const meta = await requestMeta();
  if (session.supportOrganizationId && session.user.isPlatformAdmin) {
    return buildOrgContext({ userId: session.userId, organizationId: session.supportOrganizationId, sessionId: session.id, meta, supportView: true });
  }
  let organizationId = session.activeOrganizationId;
  if (organizationId) {
    const ctx = await buildOrgContext({ userId: session.userId, organizationId, sessionId: session.id, meta });
    if (ctx) return ctx;
  }
  const membership = await prisma.organizationMembership.findFirst({
    where: { userId: session.userId, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  if (!membership) return null;
  organizationId = membership.organizationId;
  return buildOrgContext({ userId: session.userId, organizationId, sessionId: session.id, meta });
});

export function hasPermission(ctx: OrgContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function assertPermission(ctx: OrgContext, permission: Permission) {
  if (!ctx.permissions.has(permission)) throw new ForbiddenError();
}

/** Any mutation performed in a support view is refused. */
export function assertWritable(ctx: OrgContext) {
  if (ctx.isSupportView) throw new ForbiddenError("Support view is read-only");
}

export function assertOrgActive(ctx: OrgContext) {
  if (ctx.organization.status !== "ACTIVE") throw new ForbiddenError("Your organization is not active");
}

// ── Page guards (redirect instead of throwing) ─────────────────────────────

/**
 * Send a logged-out visitor to the login page, remembering where they wanted to go
 * (e.g. /documents/new?type=quote&dealId=123 from the HubSpot card).
 */
async function redirectToLogin(): Promise<never> {
  const path = (await headers()).get("x-pathname") ?? "";
  const safe = path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/login") ? path : "";
  redirect(safe && safe !== "/" ? `/login?next=${encodeURIComponent(safe)}` : "/login");
}

export async function requireUserPage() {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin();
  return user;
}

const STATUS_REDIRECTS: Partial<Record<OrganizationStatus, string>> = {
  PENDING_EMAIL_VERIFICATION: "/register/company",
  PENDING_APPROVAL: "/pending-approval",
  REJECTED: "/pending-approval",
  SUSPENDED: "/suspended",
};

/** For pages of the tenant app: signed in, member of an active organization. */
export async function requireOrgPage(permission?: Permission): Promise<OrgContext> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin();
  if (!user.emailVerified) redirect("/verify-email");
  const ctx = await getOrgContext();
  if (!ctx) {
    if (user.isPlatformAdmin) redirect("/admin");
    redirect("/register/company");
  }
  const target = STATUS_REDIRECTS[ctx.organization.status];
  if (target && !ctx.isSupportView) redirect(target);
  if (permission && !ctx.permissions.has(permission)) redirect("/unauthorized");
  return ctx;
}

/** For API routes: throws instead of redirecting. */
export async function requireOrgApi(permission?: Permission): Promise<OrgContext> {
  const ctx = await getOrgContext();
  if (!ctx) throw new UnauthorizedError();
  if (ctx.organization.status !== "ACTIVE" && !ctx.isSupportView) throw new ForbiddenError("Your organization is not active");
  if (permission && !ctx.permissions.has(permission)) throw new ForbiddenError();
  return ctx;
}

export async function requirePlatformAdminPage() {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin();
  if (!user.isPlatformAdmin) redirect("/unauthorized");
  return user;
}

export async function requirePlatformAdminApi() {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  if (!user.isPlatformAdmin) throw new ForbiddenError();
  return user;
}
