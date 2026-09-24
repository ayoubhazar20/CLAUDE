import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireOrgPage } from "@/server/auth/context";
import { unreadCount } from "@/server/services/notifications";
import { prisma } from "@/server/db";
import { AppShell } from "@/components/app-shell";
import type { NavItem } from "@/components/nav-links";
import { t } from "@/i18n";
import { PERMISSIONS } from "@/domain/permissions";
import { closeSupportViewAction } from "@/app/actions/admin";

export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgPage();
  const onboardingNeeded = !ctx.organization.onboardingCompletedAt && ctx.permissions.has(PERMISSIONS.ORG_SETTINGS_MANAGE) && !ctx.isSupportView;
  const role = ctx.isSupportView ? { name: "Platform support (read-only)" } : await prisma.role.findFirst({ where: { key: ctx.roleKey, OR: [{ organizationId: null }, { organizationId: ctx.organizationId }] } });
  const nav: NavItem[] = [
    { href: "/dashboard", label: t("nav.dashboard") },
    { href: "/documents", label: t("nav.documents") },
    { href: "/documents?type=QUOTE", label: t("nav.quotes") },
    { href: "/documents?type=CONTRACT", label: t("nav.contracts") },
  ];
  if (ctx.permissions.has(PERMISSIONS.TEMPLATES_VIEW)) nav.push({ href: "/templates", label: t("nav.templates") });
  if (ctx.permissions.has(PERMISSIONS.DOCUMENTS_CREATE)) nav.push({ href: "/deals", label: t("nav.deals") });
  nav.push({ href: "/notifications", label: t("nav.notifications") }, { href: "/settings", label: t("nav.settings") });

  const banner = ctx.isSupportView ? (
    <div className="flex items-center justify-between gap-3 bg-amber-100 px-4 py-2 text-sm text-amber-900">
      <span>Support view of <strong>{ctx.organization.name}</strong> — read-only, all access is logged.</span>
      <form action={closeSupportViewAction}>
        <button type="submit" className="font-semibold underline">Exit support view</button>
      </form>
    </div>
  ) : onboardingNeeded ? (
    <div className="bg-brand-50 px-4 py-2 text-sm text-brand-700">
      Finish setting up DealDocs — <a href="/onboarding" className="font-semibold underline">continue the setup wizard</a>.
    </div>
  ) : null;

  if (!ctx.user.emailVerified) redirect("/verify-email");
  return (
    <Suspense>
      <AppShell
        orgName={ctx.organization.name}
        userName={ctx.user.name}
        userEmail={ctx.user.email}
        roleLabel={role?.name ?? ctx.roleKey}
        nav={nav}
        unread={await unreadCount(ctx.organizationId, ctx.user.id)}
        banner={banner}
        isPlatformAdmin={ctx.user.isPlatformAdmin}
      >
        {children}
      </AppShell>
    </Suspense>
  );
}
