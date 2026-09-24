import { prisma } from "@/server/db";
import { Button, Input, PageHeader, Table, Td, Th } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";

export const metadata = { title: "Audit logs" };

export default async function AdminAudit({ searchParams }: { searchParams: Promise<{ action?: string; org?: string }> }) {
  const sp = await searchParams;
  const logs = await prisma.auditLog.findMany({
    where: { ...(sp.action ? { action: { contains: sp.action.toUpperCase() } } : {}), ...(sp.org && /^[0-9a-f-]{36}$/i.test(sp.org) ? { organizationId: sp.org } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const orgs = new Map((await prisma.organization.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.organizationId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  return (
    <>
      <PageHeader title="Audit logs (all organizations)" />
      <form method="get" className="mb-4 flex max-w-md gap-2"><Input name="action" defaultValue={sp.action} placeholder="Action contains…" aria-label="Action" /><Button type="submit" variant="secondary">Filter</Button></form>
      <Table>
        <thead className="bg-slate-50"><tr><Th>When</Th><Th>Organization</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {logs.map((l) => (
            <tr key={l.id}>
              <Td className="whitespace-nowrap text-xs">{dateTimeLabel(l.createdAt)}</Td>
              <Td className="text-xs">{l.organizationId ? orgs.get(l.organizationId) ?? l.organizationId : "—"}</Td>
              <Td className="text-xs">{l.actorLabel ?? l.actorType.toLowerCase()}{l.ip ? ` · ${l.ip}` : ""}</Td>
              <Td className="font-mono text-xs">{l.action}</Td>
              <Td className="text-xs">{l.entityType} {l.entityId?.slice(0, 8)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
