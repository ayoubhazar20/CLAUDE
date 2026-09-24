import Link from "next/link";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { Badge, ButtonLink, Card, EmptyState, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { dateTimeLabel } from "@/lib/format";
import { PERMISSIONS } from "@/domain/permissions";
import { retrySyncAction } from "@/app/actions/integrations";

export const metadata = { title: "Synchronization log" };

export default async function SyncLogPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.INTEGRATIONS_MANAGE);
  const tab = (await searchParams).tab ?? "log";
  const tz = ctx.organization.timezone;
  const docs = async (ids: (string | null)[]) =>
    new Map((await prisma.document.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids.filter((x): x is string => Boolean(x)) } }, select: { id: true, number: true } })).map((d) => [d.id, d.number]));

  let content: React.ReactNode;
  if (tab === "events") {
    const events = await prisma.syncEvent.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 200 });
    const numbers = await docs(events.map((e) => e.documentId));
    content = events.length ? (
      <Table>
        <thead className="bg-slate-50"><tr><Th>Created</Th><Th>Event</Th><Th>Document</Th><Th>Status</Th><Th>Attempts</Th><Th>Error</Th><Th /></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {events.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-xs">{dateTimeLabel(e.createdAt, tz)}</Td>
              <Td className="font-mono text-xs">{e.eventType}</Td>
              <Td className="text-xs">{e.documentId ? <Link className="text-brand-700 underline" href={`/documents/${e.documentId}?tab=hubspot`}>{numbers.get(e.documentId)}</Link> : "—"}</Td>
              <Td><Badge tone={e.status === "SUCCESS" ? "green" : e.status === "FAILED" ? "red" : "gray"}>{e.status.toLowerCase()}</Badge></Td>
              <Td>{e.attempts}</Td>
              <Td className="max-w-xs text-xs text-red-700">{e.lastError}{e.nextAttemptAt && e.status === "FAILED" ? <div className="text-slate-500">Next retry {dateTimeLabel(e.nextAttemptAt, tz)}</div> : null}</Td>
              <Td className="text-right">{e.status === "FAILED" ? <InlineAction action={retrySyncAction} hidden={{ syncEventId: e.id }}>Retry</InlineAction> : null}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    ) : <EmptyState title="No events yet" />;
  } else {
    const logs = await prisma.syncLog.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 300 });
    const numbers = await docs(logs.map((l) => l.documentId));
    content = logs.length ? (
      <Card>
        <ol className="space-y-2 text-sm">
          {logs.map((l) => (
            <li key={l.id} className="flex flex-wrap items-baseline gap-x-3">
              <span className="w-44 whitespace-nowrap text-xs text-slate-500">{dateTimeLabel(l.createdAt, tz)}</span>
              <Badge tone={l.direction === "OUTBOUND" ? "indigo" : "purple"}>{l.direction === "OUTBOUND" ? "→ Zapier" : "← Zapier"}</Badge>
              <span className="font-mono text-xs">{l.eventType}</span>
              <span className={l.success ? "text-emerald-700" : "text-red-700"}>{l.success ? "Success" : "Failed"}</span>
              <span className="text-slate-700">{l.message}</span>
              {l.documentId ? <Link className="text-xs text-brand-700 underline" href={`/documents/${l.documentId}?tab=hubspot`}>{numbers.get(l.documentId) ?? "document"}</Link> : null}
            </li>
          ))}
        </ol>
      </Card>
    ) : <EmptyState title="Nothing synchronized yet" description="Events appear here as documents are created, published, sent and signed." />;
  }
  return (
    <>
      <PageHeader title="Synchronization log" description="Every exchange with Zapier, for troubleshooting." actions={<ButtonLink variant="secondary" href="/settings/integrations/zapier">Settings</ButtonLink>} />
      <Tabs active={tab} tabs={[{ key: "log", label: "Log", href: "/settings/integrations/zapier/log" }, { key: "events", label: "Outbound queue", href: "/settings/integrations/zapier/log?tab=events" }]} />
      {content}
    </>
  );
}
