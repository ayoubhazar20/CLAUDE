import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { AUTOMATION_EVENTS, listPipelines } from "@/server/hubspot/settings";
import { AppError } from "@/server/errors";
import { Alert, Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { PERMISSIONS } from "@/domain/permissions";
import { hubspotAction } from "@/app/actions/settings";
import { PipelineRuleForm } from "./rule-form";

export const metadata = { title: "Pipeline automation" };

export default async function PipelinePage() {
  const ctx = await requireOrgPage(PERMISSIONS.HUBSPOT_MANAGE);
  let pipelines: Awaited<ReturnType<typeof listPipelines>> | null = null;
  let error: string | null = null;
  try {
    pipelines = await listPipelines(ctx);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    error = e.message;
  }
  const mappings = await prisma.hubSpotPipelineMapping.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ event: "asc" }] });
  const label = (event: string) => AUTOMATION_EVENTS.find((e) => e.event === event)?.label ?? event;
  return (
    <>
      <PageHeader title="Pipeline automation" description="Move HubSpot deals to a stage when something happens in DealDocs. Stages are read live from your HubSpot pipelines." />
      <div className="space-y-5">
        {error ? <Alert tone="warning" title="HubSpot unavailable">{error}</Alert> : null}
        <Card title="Rules">
          {mappings.length ? (
            <Table>
              <thead className="bg-slate-50"><tr><Th>When</Th><Th>Pipeline</Th><Th>Move deal to stage</Th><Th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {mappings.map((m) => (
                  <tr key={m.id}>
                    <Td className="font-medium">{label(m.event)}</Td>
                    <Td>{m.pipelineLabel ?? m.pipelineId}</Td>
                    <Td>{m.stageLabel ?? m.stageId}</Td>
                    <Td className="text-right"><InlineAction action={hubspotAction} hidden={{ op: "deletePipeline", id: m.id }} confirm="Remove this rule?">Remove</InlineAction></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <p className="text-sm text-slate-500">No rules yet. Example: Quote Accepted → Sales Pipeline → Quote Accepted; Contract Signed → Sales Pipeline → Closed Won.</p>}
          <p className="mt-3 text-xs text-slate-500">A rule only moves deals that are in the rule’s pipeline. Add one rule per pipeline if you use several.</p>
        </Card>
        {pipelines ? (
          <Card title="Add or update a rule">
            <PipelineRuleForm events={AUTOMATION_EVENTS.map((e) => ({ value: e.event, label: e.label }))} pipelines={pipelines} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
