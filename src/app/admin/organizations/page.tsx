import Link from "next/link";
import type { OrganizationStatus } from "@prisma/client";
import { prisma } from "@/server/db";
import { Badge, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { dateLabel } from "@/lib/format";
import { statusTone } from "../status-tone";

export const metadata = { title: "Organizations" };

const STATUSES: OrganizationStatus[] = ["PENDING_APPROVAL", "ACTIVE", "SUSPENDED", "REJECTED", "PENDING_EMAIL_VERIFICATION"];

export default async function AdminOrganizations({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const sp = await searchParams;
  const status = STATUSES.includes(sp.status as OrganizationStatus) ? (sp.status as OrganizationStatus) : undefined;
  const orgs = await prisma.organization.findMany({
    where: { ...(status ? { status } : {}), ...(sp.q ? { name: { contains: sp.q, mode: "insensitive" as const } } : {}) },
    include: { _count: { select: { memberships: true, documents: true } }, subscriptions: { where: { status: { in: ["ACTIVE", "TRIALING"] } }, include: { plan: true }, take: 1 } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    <>
      <PageHeader title="Organizations" />
      <Tabs active={status ?? "all"} tabs={[{ key: "all", label: "All", href: "/admin/organizations" }, ...STATUSES.slice(0, 4).map((s) => ({ key: s, label: s.replace(/_/g, " ").toLowerCase(), href: `/admin/organizations?status=${s}` }))]} />
      <Table>
        <thead className="bg-slate-50"><tr><Th>Organization</Th><Th>Status</Th><Th>Plan</Th><Th>Users</Th><Th>Documents</Th><Th>Created</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {orgs.map((o) => (
            <tr key={o.id}>
              <Td><Link className="font-medium text-brand-700 underline" href={`/admin/organizations/${o.id}`}>{o.name}</Link><div className="text-xs text-slate-500">{o.country}</div></Td>
              <Td><Badge tone={statusTone(o.status)}>{o.status.replace(/_/g, " ").toLowerCase()}</Badge></Td>
              <Td>{o.subscriptions[0]?.plan.name ?? "—"}</Td>
              <Td>{o._count.memberships}</Td>
              <Td>{o._count.documents}</Td>
              <Td>{dateLabel(o.createdAt)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
