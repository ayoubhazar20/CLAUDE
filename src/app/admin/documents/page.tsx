import { prisma } from "@/server/db";
import { Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { STATUS_LABELS } from "@/domain/status";

export const metadata = { title: "Documents statistics" };

export default async function AdminDocuments() {
  const [byStatus, byType, byOrg, signatures, views] = await Promise.all([
    prisma.document.groupBy({ by: ["status"], _count: true }),
    prisma.document.groupBy({ by: ["type"], _count: true }),
    prisma.document.groupBy({ by: ["organizationId"], _count: true, orderBy: { _count: { organizationId: "desc" } }, take: 20 }),
    prisma.signature.count(),
    prisma.documentView.count(),
  ]);
  const orgs = new Map((await prisma.organization.findMany({ where: { id: { in: byOrg.map((b) => b.organizationId) } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  return (
    <>
      <PageHeader title="Documents statistics" description={`${signatures} acceptances/signatures · ${views} client views`} />
      <div className="grid gap-5 md:grid-cols-3">
        <Card title="By status"><ul className="space-y-1 text-sm">{byStatus.map((s) => <li key={s.status} className="flex justify-between"><span>{STATUS_LABELS[s.status]}</span><span className="tabular-nums">{s._count}</span></li>)}</ul></Card>
        <Card title="By type"><ul className="space-y-1 text-sm">{byType.map((s) => <li key={s.type} className="flex justify-between"><span>{s.type.toLowerCase()}</span><span className="tabular-nums">{s._count}</span></li>)}</ul></Card>
        <Card title="Top organizations">
          <Table>
            <thead><tr><Th>Organization</Th><Th className="text-right">Documents</Th></tr></thead>
            <tbody>{byOrg.map((b) => <tr key={b.organizationId}><Td>{orgs.get(b.organizationId)}</Td><Td className="text-right">{b._count}</Td></tr>)}</tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
