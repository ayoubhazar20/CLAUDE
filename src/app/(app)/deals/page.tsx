import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { documentViewFilter } from "@/server/documents/access";
import { Button, EmptyState, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { dateLabel } from "@/lib/format";

export const metadata = { title: "Deals" };

/** HubSpot deals known to DealDocs (from its own documents — HubSpot is never queried). */
export default async function DealsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireOrgPage();
  const q = ((await searchParams).q ?? "").trim();
  if (/^\d{1,30}$/.test(q)) redirect(`/deals/${q}/documents`);
  const filter = await documentViewFilter(ctx);
  const rows = await prisma.document.groupBy({
    by: ["hubspotDealId"],
    where: { AND: [filter, { hubspotDealId: { not: null }, archivedAt: null }, q ? { hubspotDealName: { contains: q, mode: "insensitive" } } : {}] },
    _count: true,
    _max: { updatedAt: true },
    orderBy: { _max: { updatedAt: "desc" } },
    take: 100,
  });
  const names = await prisma.document.findMany({
    where: { organizationId: ctx.organizationId, hubspotDealId: { in: rows.map((r) => r.hubspotDealId!) }, hubspotDealName: { not: null } },
    select: { hubspotDealId: true, hubspotDealName: true, clientCompany: true },
    orderBy: { updatedAt: "desc" },
  });
  const info = (id: string) => names.find((n) => n.hubspotDealId === id);
  return (
    <>
      <PageHeader title="Deals" description="HubSpot deals that have DealDocs documents. Open a deal from the HubSpot card, or enter its HubSpot deal ID." />
      <form method="get" className="mb-4 flex max-w-lg gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Deal name or HubSpot deal ID" aria-label="Search deals" />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No deals yet" description="Deals appear here once a quote or contract is created from HubSpot." />
      ) : (
        <Table>
          <thead className="bg-slate-50"><tr><Th>Deal</Th><Th>Client</Th><Th>Documents</Th><Th>Last activity</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.hubspotDealId}>
                <Td><Link className="font-medium text-brand-700 hover:underline" href={`/deals/${r.hubspotDealId}/documents`}>{info(r.hubspotDealId!)?.hubspotDealName ?? `Deal ${r.hubspotDealId}`}</Link><div className="text-xs text-slate-500">HubSpot #{r.hubspotDealId}</div></Td>
                <Td>{info(r.hubspotDealId!)?.clientCompany ?? "—"}</Td>
                <Td>{r._count}</Td>
                <Td className="text-slate-500">{dateLabel(r._max.updatedAt, ctx.organization.timezone)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
