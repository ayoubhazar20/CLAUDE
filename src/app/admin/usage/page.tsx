import { prisma } from "@/server/db";
import { monthStart } from "@/server/services/billing";
import { PageHeader, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Usage" };

export default async function AdminUsage() {
  const since = monthStart();
  const rows = await prisma.usageRecord.groupBy({ by: ["organizationId", "metric"], where: { periodStart: { gte: since } }, _sum: { quantity: true } });
  const orgs = new Map((await prisma.organization.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.organizationId))] } }, select: { id: true, name: true } })).map((o) => [o.id, o.name]));
  const metrics = ["DOCUMENT_CREATED", "DOCUMENT_PUBLISHED", "EMAIL_SENT", "PDF_GENERATED", "STORAGE_BYTES"];
  const byOrg = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const m = byOrg.get(r.organizationId) ?? {};
    m[r.metric] = r._sum.quantity ?? 0;
    byOrg.set(r.organizationId, m);
  }
  return (
    <>
      <PageHeader title="Usage this month" description={`Since ${since.toISOString().slice(0, 10)}`} />
      <Table>
        <thead className="bg-slate-50"><tr><Th>Organization</Th>{metrics.map((m) => <Th key={m} className="text-right">{m.replace(/_/g, " ").toLowerCase()}</Th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100">
          {[...byOrg.entries()].map(([id, m]) => (
            <tr key={id}><Td>{orgs.get(id) ?? id}</Td>{metrics.map((k) => <Td key={k} className="text-right tabular-nums">{k === "STORAGE_BYTES" ? `${Math.round((m[k] ?? 0) / 1024 / 1024)} MB` : m[k] ?? 0}</Td>)}</tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
