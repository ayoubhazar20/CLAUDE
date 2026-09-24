import { prisma } from "@/server/db";
import { Badge, PageHeader, Table, Td, Th } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";

export const metadata = { title: "HubSpot connections" };

export default async function AdminHubSpot() {
  const [connections, webhookStats] = await Promise.all([
    prisma.hubSpotConnection.findMany({ include: { organization: { select: { name: true } } }, orderBy: { installedAt: "desc" } }),
    prisma.hubSpotWebhookEvent.groupBy({ by: ["status"], _count: true }),
  ]);
  return (
    <>
      <PageHeader title="HubSpot connections" description={`Webhook events: ${webhookStats.map((w) => `${w.status.toLowerCase()} ${w._count}`).join(" · ") || "none"}`} />
      <Table>
        <thead className="bg-slate-50"><tr><Th>Organization</Th><Th>Portal</Th><Th>Status</Th><Th>Token expires</Th><Th>Last error</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {connections.map((c) => (
            <tr key={c.id}>
              <Td>{c.organization.name}</Td>
              <Td>{c.portalId}<div className="text-xs text-slate-500">{c.hubDomain}</div></Td>
              <Td><Badge tone={c.status === "CONNECTED" ? "green" : c.status === "ERROR" ? "red" : "gray"}>{c.status.toLowerCase()}</Badge></Td>
              <Td className="text-xs">{dateTimeLabel(c.expiresAt)}</Td>
              <Td className="max-w-xs text-xs text-red-700">{c.lastError ? `${c.lastError} (${dateTimeLabel(c.lastErrorAt)})` : "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
