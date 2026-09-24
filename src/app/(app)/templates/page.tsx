import Link from "next/link";
import { requireOrgPage } from "@/server/auth/context";
import { listTemplates } from "@/server/services/templates";
import { Badge, Card, EmptyState, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { dateLabel } from "@/lib/format";
import { PERMISSIONS } from "@/domain/permissions";
import { templateOpAction } from "@/app/actions/templates";
import { NewTemplateForm } from "./new-template";

export const metadata = { title: "Templates" };

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.TEMPLATES_VIEW);
  const tab = (await searchParams).tab ?? "quotes";
  const canManage = ctx.permissions.has(PERMISSIONS.TEMPLATES_MANAGE) && !ctx.isSupportView;
  const templates = await listTemplates(ctx, tab === "archived" ? { archived: true } : { type: tab === "contracts" ? "CONTRACT" : "QUOTE" });
  return (
    <>
      <PageHeader title="Templates" description="Reusable, versioned layouts for quotes and contracts. Editing a template never changes documents already created." />
      <Tabs
        active={tab}
        tabs={[
          { key: "quotes", label: "Quotes", href: "/templates" },
          { key: "contracts", label: "Contracts", href: "/templates?tab=contracts" },
          { key: "archived", label: "Archived", href: "/templates?tab=archived" },
        ]}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {templates.length === 0 ? (
            <EmptyState title="No templates here" description={tab === "archived" ? "Archived templates appear here." : "Create a template to get started."} />
          ) : (
            <Table>
              <thead className="bg-slate-50"><tr><Th>Name</Th><Th>Version</Th><Th>Updated</Th><Th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {templates.map((t) => {
                  const latest = t.versions[0];
                  const hasDraft = latest?.status === "DRAFT";
                  return (
                    <tr key={t.id}>
                      <Td>
                        <Link href={`/templates/${t.id}`} className="font-medium text-slate-900 hover:underline">{t.name}</Link>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {t.isDefault ? <Badge tone="blue">Default</Badge> : null}
                          {!t.publishedVersionId ? <Badge tone="amber">Never published</Badge> : hasDraft ? <Badge tone="gray">Unpublished changes</Badge> : <Badge tone="green">Published</Badge>}
                          <Badge>{t.documentType === "QUOTE" ? "Quote" : "Contract"}</Badge>
                        </div>
                      </Td>
                      <Td>v{latest?.version ?? 1}</Td>
                      <Td className="text-slate-500">{dateLabel(latest?.updatedAt ?? t.updatedAt, ctx.organization.timezone)}</Td>
                      <Td className="text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Link href={`/templates/${t.id}`} className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium hover:bg-slate-50">{canManage && t.status === "ACTIVE" ? "Edit" : "View"}</Link>
                          {canManage && t.status === "ACTIVE" ? (
                            <>
                              {hasDraft ? <InlineAction action={templateOpAction} hidden={{ templateId: t.id, op: "publish" }} variant="primary">Publish</InlineAction> : null}
                              <InlineAction action={templateOpAction} hidden={{ templateId: t.id, op: "duplicate" }}>Duplicate</InlineAction>
                              {!t.isDefault && t.publishedVersionId ? <InlineAction action={templateOpAction} hidden={{ templateId: t.id, op: "default" }}>Set default</InlineAction> : null}
                              <InlineAction action={templateOpAction} hidden={{ templateId: t.id, op: "archive" }} confirm="Archive this template? Existing documents are not affected.">Archive</InlineAction>
                            </>
                          ) : null}
                          {canManage && t.status === "ARCHIVED" ? <InlineAction action={templateOpAction} hidden={{ templateId: t.id, op: "restore" }}>Restore</InlineAction> : null}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
        {canManage && tab !== "archived" ? (
          <Card title="Create template">
            <NewTemplateForm defaultType={tab === "contracts" ? "CONTRACT" : "QUOTE"} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
