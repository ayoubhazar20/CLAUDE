import { prisma } from "@/server/db";
import { Badge, PageHeader, Table, Td, Th } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";

export const metadata = { title: "HubSpot / Zapier integrations" };

export default async function AdminIntegrations() {
  const [integrations, failed, stats] = await Promise.all([
    prisma.zapierIntegration.findMany({ include: { organization: { select: { name: true } } }, orderBy: { updatedAt: "desc" } }),
    prisma.syncEvent.groupBy({ by: ["organizationId"], where: { status: "FAILED" }, _count: true }),
    prisma.syncEvent.groupBy({ by: ["status"], _count: true }),
  ]);
  const failedOf = (id: string) => failed.find((f) => f.organizationId === id)?._count ?? 0;
  return (
    <>
      <PageHeader title="HubSpot / Zapier integrations" description={`Outbound events: ${stats.map((s) => `${s.status.toLowerCase()} ${s._count}`).join(" · ") || "none"}`} />
      <Table>
        <thead className="bg-slate-50"><tr><Th>Organization</Th><Th>Status</Th><Th>Object type</Th><Th>Last success</Th><Th>Failed events</Th><Th>Last error</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {integrations.map((i) => (
            <tr key={i.id}>
              <Td>{i.organization.name}</Td>
              <Td><Badge tone={i.enabled && i.webhookUrl && i.secretPrefix ? "green" : "gray"}>{i.enabled && i.webhookUrl && i.secretPrefix ? "configured" : i.enabled ? "incomplete" : "disabled"}</Badge></Td>
              <Td className="font-mono text-xs">{i.hubspotObjectTypeId ?? "default"}</Td>
              <Td className="text-xs">{dateTimeLabel(i.lastSuccessAt)}</Td>
              <Td className={failedOf(i.organizationId) ? "text-red-700" : ""}>{failedOf(i.organizationId)}</Td>
              <Td className="max-w-xs text-xs text-red-700">{i.lastError ?? "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
