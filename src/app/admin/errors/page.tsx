import { prisma } from "@/server/db";
import { PageHeader, Table, Td, Th } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";

export const metadata = { title: "Errors" };

export default async function AdminErrors({ searchParams }: { searchParams: Promise<{ trace?: string }> }) {
  const trace = (await searchParams).trace;
  const errors = await prisma.errorLog.findMany({ where: trace ? { traceId: trace } : {}, orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <>
      <PageHeader title="Errors" description="Unexpected errors with their trace ids (users only see the trace id)." />
      <form method="get" className="mb-4"><input name="trace" defaultValue={trace} placeholder="Trace id (err_…)" aria-label="Trace id" className="rounded-md border border-slate-300 px-3 py-2 text-sm" /></form>
      <Table>
        <thead className="bg-slate-50"><tr><Th>When</Th><Th>Trace</Th><Th>Source</Th><Th>Message</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {errors.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-xs">{dateTimeLabel(e.createdAt)}</Td>
              <Td className="font-mono text-xs">{e.traceId}</Td>
              <Td className="text-xs">{e.source}</Td>
              <Td className="text-xs"><details><summary className="cursor-pointer">{e.message.slice(0, 160)}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[11px]">{e.stack}</pre></details></Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
