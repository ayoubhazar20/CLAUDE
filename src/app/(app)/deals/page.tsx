import Link from "next/link";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { primaryConnection } from "@/server/hubspot/client";
import { searchDeals } from "@/server/hubspot/import";
import { AppError } from "@/server/errors";
import { Alert, Button, ButtonLink, EmptyState, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";

export const metadata = { title: "Deals" };

export default async function DealsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.DOCUMENTS_CREATE);
  const q = (await searchParams).q ?? "";
  const connection = await primaryConnection(ctx.organizationId);
  if (!connection || connection.status !== "CONNECTED") {
    return (
      <>
        <PageHeader title="Deals" />
        <Alert tone="warning" title="HubSpot is not connected">Deals are read live from HubSpot. {ctx.permissions.has(PERMISSIONS.HUBSPOT_MANAGE) ? <Link href="/settings/integrations/hubspot" className="font-semibold underline">Connect HubSpot</Link> : "Ask a Company Admin to connect HubSpot."}</Alert>
      </>
    );
  }
  let deals: Awaited<ReturnType<typeof searchDeals>> = [];
  let error: string | null = null;
  try {
    deals = await searchDeals(ctx, q);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    error = e.message;
  }
  const counts = await prisma.document.groupBy({ by: ["hubspotDealId"], where: { organizationId: ctx.organizationId, hubspotDealId: { in: deals.map((d) => d.id) }, archivedAt: null }, _count: true });
  const countOf = (id: string) => counts.find((c) => c.hubspotDealId === id)?._count ?? 0;
  return (
    <>
      <PageHeader title="Deals" description="Your HubSpot deals — create a quote or contract in one click." />
      <form method="get" className="mb-4 flex max-w-lg gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Search deals…" aria-label="Search deals" />
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      {error ? <Alert tone="error" title="HubSpot API error">{error}</Alert> : deals.length === 0 ? <EmptyState title="No deals found" /> : (
        <Table>
          <thead className="bg-slate-50"><tr><Th>Deal</Th><Th>Amount</Th><Th>Close date</Th><Th>Documents</Th><Th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {deals.map((d) => (
              <tr key={d.id}>
                <Td className="font-medium">{d.name}</Td>
                <Td className="tabular-nums">{d.amount ? `${d.amount} ${d.currency}` : "—"}</Td>
                <Td>{d.closeDate ? d.closeDate.slice(0, 10) : "—"}</Td>
                <Td>{countOf(d.id) ? <Link className="text-brand-700 underline" href={`/documents?dealId=${d.id}`}>{countOf(d.id)} document{countOf(d.id) > 1 ? "s" : ""}</Link> : "—"}</Td>
                <Td className="space-x-2 whitespace-nowrap text-right">
                  <ButtonLink size="sm" href={`/documents/new?type=QUOTE&dealId=${d.id}`}>Quote</ButtonLink>
                  <ButtonLink size="sm" variant="secondary" href={`/documents/new?type=CONTRACT&dealId=${d.id}`}>Contract</ButtonLink>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
