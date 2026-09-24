import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { Card, EmptyState, PageHeader, Table, Td, Th } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { PERMISSIONS } from "@/domain/permissions";
import { customFieldAction } from "@/app/actions/settings";
import { CustomFieldForm } from "./form";

export const metadata = { title: "Custom variables" };

export default async function VariablesPage() {
  const ctx = await requireOrgPage(PERMISSIONS.CUSTOM_FIELDS_MANAGE);
  const fields = await prisma.customFieldDefinition.findMany({ where: { organizationId: ctx.organizationId, archivedAt: null }, orderBy: { key: "asc" } });
  return (
    <>
      <PageHeader title="Custom variables" description="Company-specific fields such as {{payment.terms}} or {{warranty.period}}. Users fill them in the document editor; templates insert them with the variable picker." />
      <div className="space-y-5">
        {fields.length ? (
          <Table>
            <thead className="bg-slate-50"><tr><Th>Variable</Th><Th>Label</Th><Th>Type</Th><Th>Default</Th><Th>Applies to</Th><Th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {fields.map((f) => (
                <tr key={f.id}>
                  <Td className="font-mono text-xs">{`{{${f.key}}}`}</Td>
                  <Td>{f.label}{f.required ? " *" : ""}</Td>
                  <Td>{f.type.toLowerCase().replace("_", " ")}{f.options.length ? <div className="text-xs text-slate-500">{f.options.join(", ")}</div> : null}</Td>
                  <Td className="text-xs">{f.defaultValue ?? "—"}</Td>
                  <Td className="text-xs">{f.appliesTo.map((a) => a.toLowerCase()).join(", ")}</Td>
                  <Td className="text-right"><InlineAction action={customFieldAction} hidden={{ op: "archive", id: f.id }} confirm="Archive this variable? Existing documents keep their values.">Archive</InlineAction></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No custom variables yet" />}
        <Card title="New variable"><CustomFieldForm /></Card>
      </div>
    </>
  );
}
