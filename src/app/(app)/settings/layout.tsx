import { requireOrgPage } from "@/server/auth/context";
import { PERMISSIONS, type Permission } from "@/domain/permissions";
import { SettingsNav } from "./settings-nav";

const ITEMS: { href: string; label: string; permission?: Permission }[] = [
  { href: "/settings", label: "Company profile" },
  { href: "/settings/branding", label: "Branding", permission: PERMISSIONS.ORG_SETTINGS_MANAGE },
  { href: "/settings/users", label: "Users & roles", permission: PERMISSIONS.USERS_VIEW },
  { href: "/settings/teams", label: "Teams", permission: PERMISSIONS.TEAMS_MANAGE },
  { href: "/settings/integrations/hubspot", label: "HubSpot", permission: PERMISSIONS.HUBSPOT_MANAGE },
  { href: "/settings/integrations/hubspot/mapping", label: "↳ Property mapping", permission: PERMISSIONS.HUBSPOT_MANAGE },
  { href: "/settings/integrations/hubspot/pipeline", label: "↳ Pipeline automation", permission: PERMISSIONS.HUBSPOT_MANAGE },
  { href: "/settings/email-templates", label: "Email templates", permission: PERMISSIONS.EMAIL_TEMPLATES_MANAGE },
  { href: "/settings/variables", label: "Custom variables", permission: PERMISSIONS.CUSTOM_FIELDS_MANAGE },
  { href: "/settings/numbering", label: "Numbering", permission: PERMISSIONS.ORG_SETTINGS_MANAGE },
  { href: "/settings/billing", label: "Plan & usage", permission: PERMISSIONS.BILLING_VIEW },
  { href: "/settings/audit", label: "Audit log", permission: PERMISSIONS.AUDIT_VIEW },
];

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgPage();
  const items = ITEMS.filter((i) => !i.permission || ctx.permissions.has(i.permission));
  return (
    <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
      <SettingsNav items={items} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
