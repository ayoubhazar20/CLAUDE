import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { ButtonLink, EmptyState, Input, PageHeader, Table, Td, Th, Button } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";
import { PERMISSIONS } from "@/domain/permissions";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ action?: string; page?: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.AUDIT_VIEW);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const where = { organizationId: ctx.organizationId, ...(sp.action ? { action: { contains: sp.action.toUpperCase() } } : {}) };
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * 50, take: 50 }),
    prisma.auditLog.count({ where }),
  ]);
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.userId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
  return (
    <>
      <PageHeader title="Audit log" description="Immutable record of administrative and document actions." />
      <form method="get" className="mb-4 flex gap-2">
        <Input name="action" defaultValue={sp.action} placeholder="Filter by action, e.g. DOCUMENT_SIGNED" aria-label="Filter by action" className="max-w-sm" />
        <Button type="submit" variant="secondary">Filter</Button>
      </form>
      {logs.length === 0 ? <EmptyState title="No entries" /> : (
        <Table>
          <thead className="bg-slate-50"><tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th><Th>Details</Th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {logs.map((l) => {
              const u = l.userId ? users.get(l.userId) : null;
              return (
                <tr key={l.id}>
                  <Td className="whitespace-nowrap text-xs">{dateTimeLabel(l.createdAt, ctx.organization.timezone)}</Td>
                  <Td className="text-xs">{u ? `${u.name}` : l.actorLabel ?? l.actorType.toLowerCase()}{l.actorType === "PLATFORM_ADMIN" ? " (DealDocs support)" : ""}{l.ip ? <div className="text-slate-500">{l.ip}</div> : null}</Td>
                  <Td className="font-mono text-xs">{l.action}</Td>
                  <Td className="text-xs">{l.entityType}{l.entityType === "Document" && l.entityId ? <a className="ml-1 text-brand-700 underline" href={`/documents/${l.entityId}`}>open</a> : null}</Td>
                  <Td className="max-w-md truncate font-mono text-[11px] text-slate-600" >{JSON.stringify({ ...(l.metadata as object), ...(l.newValue ? { new: l.newValue } : {}) }).slice(0, 200)}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <div className="mt-4 flex justify-between text-sm">
        <span className="text-slate-500">{total} entries</span>
        <div className="flex gap-2">
          {page > 1 ? <ButtonLink size="sm" variant="secondary" href={`/settings/audit?page=${page - 1}${sp.action ? `&action=${sp.action}` : ""}`}>Previous</ButtonLink> : null}
          {page * 50 < total ? <ButtonLink size="sm" variant="secondary" href={`/settings/audit?page=${page + 1}${sp.action ? `&action=${sp.action}` : ""}`}>Next</ButtonLink> : null}
        </div>
      </div>
    </>
  );
}
