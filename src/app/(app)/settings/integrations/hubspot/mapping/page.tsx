import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { primaryConnection } from "@/server/hubspot/client";
import { listHubSpotProperties } from "@/server/hubspot/settings";
import { WRITEBACK_SOURCES } from "@/server/hubspot/mapping";
import { AppError } from "@/server/errors";
import { Alert, Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { PERMISSIONS } from "@/domain/permissions";
import { hubspotAction } from "@/app/actions/settings";
import { ImportMappingForm, WritebackMappingForm } from "./forms";

export const metadata = { title: "Property mapping" };

async function safeProps(ctx: Parameters<typeof listHubSpotProperties>[0], type: "DEAL" | "CONTACT" | "COMPANY") {
  try {
    return await listHubSpotProperties(ctx, type);
  } catch (e) {
    if (e instanceof AppError) return null;
    throw e;
  }
}

export default async function MappingPage() {
  const ctx = await requireOrgPage(PERMISSIONS.HUBSPOT_MANAGE);
  const connection = await primaryConnection(ctx.organizationId);
  const mappings = await prisma.hubSpotPropertyMapping.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ direction: "asc" }, { objectType: "asc" }, { hubspotProperty: "asc" }] });
  const [deal, contact, company] = connection?.status === "CONNECTED" ? await Promise.all([safeProps(ctx, "DEAL"), safeProps(ctx, "CONTACT"), safeProps(ctx, "COMPANY")]) : [null, null, null];
  const imports = mappings.filter((m) => m.direction === "IMPORT");
  const writebacks = mappings.filter((m) => m.direction === "WRITEBACK");
  const label = (key: string) => WRITEBACK_SOURCES.find((s) => s.key === key)?.label ?? key;
  return (
    <>
      <PageHeader title="Property mapping" description="Map HubSpot properties (standard or custom) to DealDocs variables, and choose which DealDocs values are written back to deals." />
      {!connection ? <Alert tone="warning">Connect HubSpot first to browse its properties.</Alert> : null}
      <div className="mt-4 space-y-6">
        <Card title="Import: HubSpot → DealDocs variables">
          <p className="mb-3 text-sm text-slate-600">
            Standard fields (deal name, amount, contact, company, owner…) are imported automatically. Add mappings for custom properties — e.g. <code>project_start_date</code> → <code>project.startDate</code> — and use them with the variable picker.
          </p>
          {imports.length ? (
            <Table>
              <thead className="bg-slate-50"><tr><Th>Object</Th><Th>HubSpot property</Th><Th>DealDocs variable</Th><Th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {imports.map((m) => (
                  <tr key={m.id}>
                    <Td>{m.objectType.toLowerCase()}</Td>
                    <Td className="font-mono text-xs">{m.hubspotProperty}</Td>
                    <Td className="font-mono text-xs">{`{{${m.variableKey}}}`}</Td>
                    <Td className="text-right"><InlineAction action={hubspotAction} hidden={{ op: "deleteMapping", id: m.id }} confirm="Remove this mapping?">Remove</InlineAction></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <p className="text-sm text-slate-500">No custom mappings yet.</p>}
          <div className="mt-4 border-t border-slate-100 pt-4">
            <ImportMappingForm properties={{ DEAL: deal, CONTACT: contact, COMPANY: company }} />
          </div>
        </Card>

        <Card
          title="Writeback: DealDocs → HubSpot deal"
          actions={connection?.status === "CONNECTED" ? <InlineAction action={hubspotAction} hidden={{ op: "installWriteback" }} variant="primary" confirm="Create the DealDocs property group and properties on HubSpot deals and map them?">Create DealDocs properties</InlineAction> : null}
        >
          <p className="mb-3 text-sm text-slate-600">When several documents exist for a deal, “latest” is the most recently created published document of that type, and “primary” is the one marked as primary.</p>
          {writebacks.length ? (
            <Table>
              <thead className="bg-slate-50"><tr><Th>DealDocs value</Th><Th>HubSpot deal property</Th><Th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {writebacks.map((m) => (
                  <tr key={m.id}>
                    <Td>{label(m.variableKey)}</Td>
                    <Td className="font-mono text-xs">{m.hubspotProperty}</Td>
                    <Td className="text-right"><InlineAction action={hubspotAction} hidden={{ op: "deleteMapping", id: m.id }}>Remove</InlineAction></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <p className="text-sm text-slate-500">Nothing is written back yet.</p>}
          <div className="mt-4 border-t border-slate-100 pt-4">
            <WritebackMappingForm sources={WRITEBACK_SOURCES.map((s) => ({ key: s.key, label: s.label }))} dealProperties={deal?.filter((p) => !p.readOnly) ?? null} />
          </div>
        </Card>
      </div>
    </>
  );
}
