import { systemHealth } from "@/server/services/platform";
import { Card, DescriptionList, PageHeader, Table, Td, Th } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";

export const metadata = { title: "System health" };

export default async function AdminHealth() {
  const h = await systemHealth();
  return (
    <>
      <PageHeader title="System health" />
      <div className="space-y-5">
        <Card title="Status">
          <DescriptionList
            items={[
              { label: "Database", value: `${h.database} (${h.dbLatencyMs} ms)` },
              { label: "Pending jobs", value: h.pendingJobs },
              { label: "Queue lag", value: `${h.queueLagSeconds} s` },
              { label: "Running jobs", value: h.runningJobs },
              { label: "Failed emails", value: h.failedEmails },
              { label: "Failed Zapier sync events", value: h.failedSyncEvents },
              { label: "Node.js", value: process.version },
              { label: "Uptime", value: `${Math.round(process.uptime() / 60)} min` },
            ]}
          />
        </Card>
        <Card title="Dead jobs (exhausted retries)">
          {h.deadJobs.length ? (
            <Table>
              <thead className="bg-slate-50"><tr><Th>Type</Th><Th>Attempts</Th><Th>Error</Th><Th>Created</Th></tr></thead>
              <tbody className="divide-y divide-slate-100">{h.deadJobs.map((j) => <tr key={j.id}><Td className="font-mono text-xs">{j.type}</Td><Td>{j.attempts}</Td><Td className="max-w-md text-xs text-red-700">{j.lastError}</Td><Td className="text-xs">{dateTimeLabel(j.createdAt)}</Td></tr>)}</tbody>
            </Table>
          ) : <p className="text-sm text-slate-500">None.</p>}
        </Card>
      </div>
    </>
  );
}
