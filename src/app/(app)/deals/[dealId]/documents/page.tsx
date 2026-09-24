import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { documentViewFilter } from "@/server/documents/access";
import { Badge, ButtonLink, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { dateLabel, money } from "@/lib/format";
import { PERMISSIONS } from "@/domain/permissions";
import { DOCUMENT_TYPE_LABELS } from "@/domain/status";

export const metadata = { title: "Deal documents" };

/**
 * "View Documents" target of the HubSpot card: every quote and contract of the deal,
 * read from DealDocs' own database, restricted to the user's organization and access scope.
 */
export default async function DealDocumentsPage({ params }: { params: Promise<{ dealId: string }> }) {
  const ctx = await requireOrgPage();
  const { dealId } = await params;
  if (!/^\d{1,30}$/.test(dealId)) notFound();
  const filter = await documentViewFilter(ctx);
  const docs = await prisma.document.findMany({
    where: { AND: [filter, { hubspotDealId: dealId }] },
    include: { owner: { select: { name: true } } },
    orderBy: [{ archivedAt: "asc" }, { createdAt: "desc" }],
  });
  const name = docs.find((d) => d.hubspotDealName)?.hubspotDealName;
  const canCreate = ctx.permissions.has(PERMISSIONS.DOCUMENTS_CREATE) && !ctx.isSupportView;
  return (
    <>
      <PageHeader
        back={{ href: "/deals", label: "Deals" }}
        title={name ?? `HubSpot deal ${dealId}`}
        description={`HubSpot deal #${dealId} · ${docs.length} document${docs.length === 1 ? "" : "s"}`}
        actions={
          canCreate ? (
            <>
              <ButtonLink href={`/documents/new?type=quote&dealId=${dealId}`}>+ Create Quote</ButtonLink>
              <ButtonLink variant="secondary" href={`/documents/new?type=contract&dealId=${dealId}`}>+ Create Contract</ButtonLink>
            </>
          ) : null
        }
      />
      {docs.length === 0 ? (
        <EmptyState title="No documents for this deal yet" description="Create a quote or contract to get started." />
      ) : (
        <Table>
          <thead className="bg-slate-50"><tr><Th>Document</Th><Th>Status</Th><Th className="text-right">Amount</Th><Th>Owner</Th><Th>HubSpot record</Th><Th>Created</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {docs.map((d) => (
              <tr key={d.id} className={d.archivedAt ? "opacity-60" : ""}>
                <Td>
                  <Link href={`/documents/${d.id}`} className="font-medium text-slate-900 hover:underline">{DOCUMENT_TYPE_LABELS[d.type]} {d.number}</Link>
                  <div className="text-xs text-slate-500">{d.title}</div>
                  <div className="mt-1 flex gap-1">{d.isPrimary ? <Badge tone="blue">Primary</Badge> : null}{d.archivedAt ? <Badge>Archived</Badge> : null}</div>
                </Td>
                <Td><StatusBadge status={d.status} /></Td>
                <Td className="text-right tabular-nums">{money(d.grandTotal, d.currency)}</Td>
                <Td>{d.owner.name}</Td>
                <Td className="text-xs">{d.hubspotObjectRecordId ?? <span className="text-slate-400">pending</span>}</Td>
                <Td className="text-slate-500">{dateLabel(d.createdAt, ctx.organization.timezone)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
