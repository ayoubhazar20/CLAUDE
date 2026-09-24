import Link from "next/link";
import { platformOverview } from "@/server/services/platform";
import { Card, PageHeader, Stat } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";

export const metadata = { title: "Platform overview" };

export default async function AdminOverview() {
  const o = await platformOverview();
  const orgCount = (s: string) => o.orgsByStatus.find((x) => x.status === s)?._count ?? 0;
  return (
    <>
      <PageHeader title="Platform overview" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Pending approval" value={orgCount("PENDING_APPROVAL")} href="/admin/organizations?status=PENDING_APPROVAL" tone="text-amber-700" />
        <Stat label="Active organizations" value={orgCount("ACTIVE")} href="/admin/organizations?status=ACTIVE" />
        <Stat label="Users" value={o.users} href="/admin/users" />
        <Stat label="Documents" value={o.documents} href="/admin/documents" />
        <Stat label="Suspended" value={orgCount("SUSPENDED")} href="/admin/organizations?status=SUSPENDED" />
        <Stat label="Jobs retrying" value={o.failedJobs} href="/admin/health" />
        <Stat label="Dead jobs" value={o.deadJobs} href="/admin/health" tone={o.deadJobs ? "text-red-700" : undefined} />
        <Stat label="Errors (24h)" value={o.recentErrors} href="/admin/errors" tone={o.recentErrors ? "text-red-700" : undefined} />
      </div>
      <div className="mt-6">
        <Card title="Awaiting approval">
          {o.pendingOrgs.length ? (
            <ul className="divide-y divide-slate-100 text-sm">
              {o.pendingOrgs.map((org) => (
                <li key={org.id} className="flex justify-between py-2">
                  <Link href={`/admin/organizations/${org.id}`} className="font-medium text-brand-700 underline">{org.name}</Link>
                  <span className="text-slate-500">{org.country} · submitted {dateTimeLabel(org.submittedAt)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-500">No organizations waiting.</p>}
        </Card>
      </div>
    </>
  );
}
