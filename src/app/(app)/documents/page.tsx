import Link from "next/link";
import { requireOrgPage } from "@/server/auth/context";
import { listDocuments, parseListFilters, type ListFilters } from "@/server/documents/queries";
import { prisma } from "@/server/db";
import { Button, ButtonLink, EmptyState, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { dateLabel, money } from "@/lib/format";
import { PERMISSIONS } from "@/domain/permissions";
import { CONTRACT_STATUSES, DOCUMENT_TYPE_LABELS, QUOTE_STATUSES, STATUS_LABELS } from "@/domain/status";
import { CURRENCY_CODES } from "@/domain/currencies";

export const metadata = { title: "Documents" };

function buildHref(filters: ListFilters, patch: Partial<Record<keyof ListFilters, string | number | undefined>>) {
  const params = new URLSearchParams();
  const merged = { ...filters, ...patch } as Record<string, unknown>;
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === "" || v === null) continue;
    if ((k === "page" && v === 1) || (k === "pageSize" && v === 20) || (k === "sort" && v === "updatedAt") || (k === "dir" && v === "desc")) continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return `/documents${qs ? `?${qs}` : ""}`;
}

function SortHeader({ filters, field, children, className }: { filters: ListFilters; field: ListFilters["sort"]; children: React.ReactNode; className?: string }) {
  const active = filters.sort === field;
  const dir = active && filters.dir === "desc" ? "asc" : "desc";
  return (
    <Th className={className}>
      <Link href={buildHref(filters, { sort: field, dir, page: 1 })} className="inline-flex items-center gap-1 hover:text-slate-800" aria-sort={active ? (filters.dir === "asc" ? "ascending" : "descending") : undefined}>
        {children}
        {active ? <span aria-hidden="true">{filters.dir === "asc" ? "▲" : "▼"}</span> : null}
      </Link>
    </Th>
  );
}

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireOrgPage();
  const filters = parseListFilters(await searchParams);
  const [result, members, templates] = await Promise.all([
    listDocuments(ctx, filters),
    prisma.organizationMembership.findMany({ where: { organizationId: ctx.organizationId }, include: { user: { select: { id: true, name: true } } } }),
    prisma.template.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true } }),
  ]);
  const title = filters.type === "QUOTE" ? "Quotes" : filters.type === "CONTRACT" ? "Contracts" : "Documents";
  const statuses = filters.type === "QUOTE" ? QUOTE_STATUSES : filters.type === "CONTRACT" ? CONTRACT_STATUSES : [...new Set([...QUOTE_STATUSES, ...CONTRACT_STATUSES])];
  const canCreate = ctx.permissions.has(PERMISSIONS.DOCUMENTS_CREATE) && !ctx.isSupportView;
  const advanced = Boolean(filters.ownerId || filters.client || filters.company || filters.dealId || filters.templateId || filters.currency || filters.minAmount !== undefined || filters.maxAmount !== undefined || filters.from || filters.to);

  return (
    <>
      <PageHeader
        title={title}
        description={`${result.total} document${result.total === 1 ? "" : "s"}${filters.archived === "1" ? " (archived)" : ""}`}
        actions={canCreate ? <ButtonLink href={`/documents/new${filters.type ? `?type=${filters.type}` : ""}`}>+ New {filters.type ? DOCUMENT_TYPE_LABELS[filters.type].toLowerCase() : "document"}</ButtonLink> : null}
      />
      <form method="get" className="mb-4 rounded-lg border border-slate-200 bg-white p-3" role="search" aria-label="Filter documents">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <label htmlFor="q" className="sr-only">Search</label>
            <Input id="q" name="q" defaultValue={filters.q} placeholder="Search number, title, client, deal…" />
          </div>
          <div>
            <label htmlFor="type" className="sr-only">Type</label>
            <Select id="type" name="type" defaultValue={filters.type ?? ""}>
              <option value="">All types</option>
              <option value="QUOTE">Quotes</option>
              <option value="CONTRACT">Contracts</option>
            </Select>
          </div>
          <div>
            <label htmlFor="status" className="sr-only">Status</label>
            <Select id="status" name="status" defaultValue={filters.status ?? ""}>
              <option value="">All statuses</option>
              {statuses.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </Select>
          </div>
          <div className="flex gap-2">
            <Button type="submit" className="flex-1">Filter</Button>
            <ButtonLink href={filters.type ? `/documents?type=${filters.type}` : "/documents"} variant="secondary">Reset</ButtonLink>
          </div>
        </div>
        <details className="mt-2" open={advanced}>
          <summary className="cursor-pointer text-sm text-slate-600">More filters</summary>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select name="ownerId" defaultValue={filters.ownerId ?? ""} aria-label="Owner">
              <option value="">Any owner</option>
              {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
            </Select>
            <Input name="client" defaultValue={filters.client} placeholder="Client name" aria-label="Client" />
            <Input name="company" defaultValue={filters.company} placeholder="Client company" aria-label="Company" />
            <Input name="dealId" defaultValue={filters.dealId} placeholder="HubSpot deal ID" aria-label="HubSpot deal ID" inputMode="numeric" />
            <Select name="templateId" defaultValue={filters.templateId ?? ""} aria-label="Template">
              <option value="">Any template</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <Select name="currency" defaultValue={filters.currency ?? ""} aria-label="Currency">
              <option value="">Any currency</option>
              {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
            <div className="flex gap-2">
              <Input name="minAmount" type="number" min="0" step="any" defaultValue={filters.minAmount} placeholder="Min amount" aria-label="Minimum amount" />
              <Input name="maxAmount" type="number" min="0" step="any" defaultValue={filters.maxAmount} placeholder="Max amount" aria-label="Maximum amount" />
            </div>
            <div className="flex gap-2">
              <Input name="from" type="date" defaultValue={filters.from} aria-label="Created from" />
              <Input name="to" type="date" defaultValue={filters.to} aria-label="Created to" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="archived" value="1" defaultChecked={filters.archived === "1"} /> Show archived
            </label>
          </div>
        </details>
      </form>

      {result.rows.length === 0 ? (
        <EmptyState
          title={filters.q || advanced || filters.status ? "No documents match your filters" : "No documents yet"}
          description={filters.q || advanced || filters.status ? "Try adjusting or resetting the filters." : "Create a quote or contract from a HubSpot deal."}
          action={canCreate ? <ButtonLink href="/documents/new">Create a document</ButtonLink> : undefined}
        />
      ) : (
        <>
          <Table>
            <thead className="bg-slate-50">
              <tr>
                <SortHeader filters={filters} field="number">Number</SortHeader>
                <SortHeader filters={filters} field="clientName">Client</SortHeader>
                <Th className="hidden md:table-cell">Deal</Th>
                <SortHeader filters={filters} field="status">Status</SortHeader>
                <SortHeader filters={filters} field="grandTotal" className="text-right">Amount</SortHeader>
                <Th className="hidden lg:table-cell">Owner</Th>
                <SortHeader filters={filters} field="updatedAt" className="hidden sm:table-cell">Updated</SortHeader>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`/documents/${d.id}`} className="font-medium text-slate-900 hover:underline">{d.number}</Link>
                    <div className="max-w-xs truncate text-xs text-slate-500">{DOCUMENT_TYPE_LABELS[d.type]} · {d.title}</div>
                    {d.isPrimary ? <span className="text-xs font-medium text-brand-700">Primary</span> : null}
                  </Td>
                  <Td>
                    <div>{d.clientName ?? "—"}</div>
                    <div className="text-xs text-slate-500">{d.clientCompany}</div>
                  </Td>
                  <Td className="hidden md:table-cell">{d.hubspotDealName ?? "—"}</Td>
                  <Td><StatusBadge status={d.status} /></Td>
                  <Td className="text-right tabular-nums">{money(d.grandTotal, d.currency)}</Td>
                  <Td className="hidden lg:table-cell">{d.owner.name}</Td>
                  <Td className="hidden whitespace-nowrap text-slate-500 sm:table-cell">{dateLabel(d.updatedAt, ctx.organization.timezone)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
            <span className="text-slate-600">Page {result.page} of {result.pages}</span>
            <div className="flex gap-2">
              {result.page > 1 ? <ButtonLink variant="secondary" size="sm" href={buildHref(filters, { page: result.page - 1 })}>Previous</ButtonLink> : null}
              {result.page < result.pages ? <ButtonLink variant="secondary" size="sm" href={buildHref(filters, { page: result.page + 1 })}>Next</ButtonLink> : null}
            </div>
          </nav>
        </>
      )}
    </>
  );
}
