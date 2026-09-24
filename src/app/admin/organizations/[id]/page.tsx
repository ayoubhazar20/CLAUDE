import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { currentUsage } from "@/server/services/billing";
import { Badge, Card, DescriptionList, PageHeader, Table, Td, Th } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";
import { openSupportViewAction } from "@/app/actions/admin";
import { LifecycleForms, PlanForm } from "./forms";
import { statusTone } from "../../status-tone";

export const metadata = { title: "Organization" };

export default async function AdminOrganization({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const org = await prisma.organization.findUnique({
    where: { id },
    include: { memberships: { include: { user: true, role: true } }, hubspotConnections: true, termsAcceptances: true, subscriptions: { include: { plan: true }, orderBy: { createdAt: "desc" } } },
  });
  if (!org) notFound();
  const [usage, plans, audit] = await Promise.all([
    currentUsage(org.id),
    prisma.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.auditLog.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  const activeSub = org.subscriptions.find((s) => ["ACTIVE", "TRIALING", "PAST_DUE"].includes(s.status));
  return (
    <>
      <PageHeader back={{ href: "/admin/organizations", label: "Organizations" }} title={<span className="flex items-center gap-3">{org.name}<Badge tone={statusTone(org.status)}>{org.status.replace(/_/g, " ").toLowerCase()}</Badge></span>} />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Company">
            <DescriptionList
              items={[
                { label: "Legal name", value: org.legalName },
                { label: "Country", value: org.country },
                { label: "Address", value: [org.addressLine1, org.addressLine2, org.postalCode, org.city, org.region].filter(Boolean).join(", ") },
                { label: "Currency / timezone", value: `${org.defaultCurrency} · ${org.timezone}` },
                { label: "Registration", value: org.registrationNumber },
                { label: "VAT", value: org.vatNumber },
                { label: "Submitted", value: dateTimeLabel(org.submittedAt) },
                { label: "Approved", value: dateTimeLabel(org.approvedAt) },
              ]}
            />
            {org.rejectionReason ? <p className="mt-3 text-sm text-red-700">Rejection reason: {org.rejectionReason}</p> : null}
            {org.suspensionReason ? <p className="mt-3 text-sm text-red-700">Suspension reason: {org.suspensionReason}</p> : null}
          </Card>
          <Card title="Members">
            <Table>
              <thead className="bg-slate-50"><tr><Th>User</Th><Th>Role</Th><Th>Status</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {org.memberships.map((m) => <tr key={m.id}><Td>{m.user.name}<div className="text-xs text-slate-500">{m.user.email}{m.user.emailVerifiedAt ? " · verified" : " · unverified"}</div></Td><Td>{m.role.name}</Td><Td>{m.status.toLowerCase()}</Td></tr>)}
              </tbody>
            </Table>
          </Card>
          <Card title="Legal acceptances">
            <ul className="text-sm">{org.termsAcceptances.map((t) => <li key={t.id}>{t.documentType.replace(/_/g, " ").toLowerCase()} v{t.version} — {dateTimeLabel(t.acceptedAt)} {t.ip ? `(${t.ip})` : ""}</li>)}</ul>
          </Card>
          <Card title="Recent audit events">
            <ul className="space-y-1 text-xs">{audit.map((a) => <li key={a.id}><span className="text-slate-500">{dateTimeLabel(a.createdAt)}</span> <span className="font-mono">{a.action}</span></li>)}</ul>
          </Card>
        </div>
        <div className="space-y-5">
          <Card title="Actions">
            <LifecycleForms organizationId={org.id} status={org.status} />
            <form action={openSupportViewAction} className="mt-4 border-t border-slate-100 pt-4">
              <input type="hidden" name="organizationId" value={org.id} />
              <button type="submit" className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50">Open support view (read-only, logged)</button>
            </form>
          </Card>
          <Card title="Plan">
            <p className="mb-2 text-sm">Current: <strong>{activeSub?.plan.name ?? "None"}</strong></p>
            <PlanForm organizationId={org.id} plans={plans.map((p) => ({ id: p.id, name: p.name }))} current={activeSub?.planId ?? null} />
          </Card>
          <Card title="Usage">
            <DescriptionList items={[{ label: "Active users", value: usage.users }, { label: "Documents this month", value: usage.documentsThisMonth }, { label: "Storage", value: `${Math.round(usage.storageBytes / 1024 / 1024)} MB` }]} />
          </Card>
          <Card title="HubSpot">
            {org.hubspotConnections.length ? org.hubspotConnections.map((c) => <p key={c.id} className="text-sm">Portal {c.portalId} · {c.status.toLowerCase()}{c.lastError ? <span className="block text-xs text-red-600">{c.lastError}</span> : null}</p>) : <p className="text-sm text-slate-500">Not connected</p>}
          </Card>
        </div>
      </div>
    </>
  );
}
