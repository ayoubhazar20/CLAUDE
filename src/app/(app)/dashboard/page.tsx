import Link from "next/link";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { dashboardStats } from "@/server/documents/queries";
import { getIntegration, isConfigured } from "@/server/integrations/config";
import { Alert, ButtonLink, Card, EmptyState, PageHeader, Stat, Table, Td, Th } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { money, relativeTime } from "@/lib/format";
import { PERMISSIONS } from "@/domain/permissions";
import { DOCUMENT_TYPE_LABELS } from "@/domain/status";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const ctx = await requireOrgPage();
  const [stats, integration] = await Promise.all([dashboardStats(ctx), getIntegration(ctx.organizationId)]);
  const failing = await prisma.syncEvent.count({ where: { organizationId: ctx.organizationId, status: "FAILED", createdAt: { gte: new Date(Date.now() - 7 * 86400_000) } } });
  const canCreate = ctx.permissions.has(PERMISSIONS.DOCUMENTS_CREATE) && !ctx.isSupportView;
  const c = stats.cards;
  return (
    <>
      <PageHeader
        title={`Hello, ${ctx.user.name.split(" ")[0]}`}
        description="Your quotes and contracts at a glance."
        actions={canCreate ? <ButtonLink href="/documents/new">+ New document</ButtonLink> : null}
      />
      {!isConfigured(integration) ? (
        <div className="mb-6">
          <Alert tone="warning" title="HubSpot sync is not set up">
            {ctx.permissions.has(PERMISSIONS.INTEGRATIONS_MANAGE) ? (
              <>Documents are not mirrored to HubSpot yet. <Link className="font-semibold underline" href="/settings/integrations/zapier">Configure HubSpot via Zapier</Link></>
            ) : (
              <>Ask a Company Admin to configure HubSpot via Zapier so documents appear in HubSpot.</>
            )}
          </Alert>
        </div>
      ) : failing > 0 && ctx.permissions.has(PERMISSIONS.INTEGRATIONS_MANAGE) ? (
        <div className="mb-6">
          <Alert tone="error" title="Some HubSpot updates failed">
            {failing} event{failing > 1 ? "s" : ""} could not be delivered to Zapier this week. <Link className="font-semibold underline" href="/settings/integrations/zapier/log?tab=events">Review and retry</Link>
          </Alert>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Drafts" value={c.drafts} href="/documents?status=DRAFT" />
        <Stat label="Published" value={c.published} href="/documents?status=PUBLISHED" />
        <Stat label="Awaiting signature" value={c.awaiting} href="/documents?type=CONTRACT&status=AWAITING_SIGNATURE" tone="text-amber-700" />
        <Stat label="Accepted quotes" value={c.accepted} href="/documents?type=QUOTE&status=ACCEPTED" tone="text-emerald-700" />
        <Stat label="Signed contracts" value={c.signed} href="/documents?type=CONTRACT&status=SIGNED" tone="text-emerald-700" />
        <Stat label="Expired" value={c.expired} href="/documents?status=EXPIRED" tone="text-slate-500" />
      </div>
      <div className="mt-6">
        <Card title="Recent activity" actions={<Link href="/documents" className="text-sm text-brand-700 hover:underline">View all</Link>}>
          {stats.recent.length === 0 ? (
            <EmptyState
              title="No documents yet"
              description="Create your first quote from a HubSpot deal — it only takes a minute."
              action={canCreate ? <ButtonLink href="/documents/new">Create a document</ButtonLink> : undefined}
            />
          ) : (
            <Table>
              <thead className="bg-slate-50">
                <tr><Th>Document</Th><Th>Client</Th><Th>Status</Th><Th className="text-right">Amount</Th><Th>Updated</Th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stats.recent.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <Td>
                      <Link href={`/documents/${d.id}`} className="font-medium text-slate-900 hover:underline">{d.number}</Link>
                      <div className="text-xs text-slate-500">{DOCUMENT_TYPE_LABELS[d.type]} · {d.title}</div>
                    </Td>
                    <Td>{d.clientCompany ?? d.clientName ?? "—"}</Td>
                    <Td><StatusBadge status={d.status} /></Td>
                    <Td className="text-right tabular-nums">{money(d.grandTotal, d.currency)}</Td>
                    <Td className="whitespace-nowrap text-slate-500">{relativeTime(d.updatedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
