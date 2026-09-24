import { requireOrgPage } from "@/server/auth/context";
import { activePlan, currentUsage } from "@/server/services/billing";
import { Card, DescriptionList, PageHeader } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";

export const metadata = { title: "Plan & usage" };

function Meter({ label, used, limit, unit = "" }: { label: string; used: number; limit: number | null; unit?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm"><span>{label}</span><span className="tabular-nums text-slate-600">{used}{unit} / {limit === null ? "Unlimited" : `${limit}${unit}`}</span></div>
      <div className="mt-1 h-2 rounded bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-2 rounded ${pct > 90 ? "bg-red-500" : "bg-brand-600"}`} style={{ width: `${limit ? pct : 0}%` }} />
      </div>
    </div>
  );
}

export default async function BillingPage() {
  const ctx = await requireOrgPage(PERMISSIONS.BILLING_VIEW);
  const [plan, usage] = await Promise.all([activePlan(ctx.organizationId), currentUsage(ctx.organizationId)]);
  return (
    <>
      <PageHeader title="Plan & usage" description="Billing is not active yet. Plans and limits are managed by the DealDocs team." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Plan">
          <DescriptionList items={[{ label: "Current plan", value: plan?.name ?? "No plan (unrestricted)" }, { label: "Features", value: plan ? (plan.features.includes("*") ? "All features" : plan.features.join(", ")) : "All features" }]} />
        </Card>
        <Card title="Usage this month">
          <div className="space-y-4">
            <Meter label="Active users" used={usage.users} limit={plan?.maxUsers ?? null} />
            <Meter label="Documents created" used={usage.documentsThisMonth} limit={plan?.maxDocumentsPerMonth ?? null} />
            <Meter label="Storage" used={Math.round(usage.storageBytes / 1024 / 1024)} limit={plan?.maxStorageMb ?? null} unit=" MB" />
            <Meter label="HubSpot connections" used={usage.hubspotConnections} limit={plan?.maxHubSpotConnections ?? null} />
          </div>
        </Card>
      </div>
    </>
  );
}
