import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getIntegration, isConfigured } from "@/server/integrations/config";
import { documentViewFilter } from "@/server/documents/access";
import { Alert, ButtonLink, PageHeader } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";
import { NewDocumentWizard } from "./wizard";

export const metadata = { title: "New document" };

export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<{ type?: string; dealId?: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.DOCUMENTS_CREATE);
  const sp = await searchParams;
  const dealId = sp.dealId && /^\d{1,30}$/.test(sp.dealId) ? sp.dealId : null;
  const [templates, integration, existing] = await Promise.all([
    prisma.template.findMany({
      where: { organizationId: ctx.organizationId, status: "ACTIVE", publishedVersionId: { not: null } },
      select: { id: true, name: true, documentType: true, isDefault: true, description: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
    getIntegration(ctx.organizationId),
    dealId ? prisma.document.findMany({ where: { AND: [await documentViewFilter(ctx), { hubspotDealId: dealId }] }, select: { id: true } }) : Promise.resolve([]),
  ]);
  if (!templates.length) {
    return (
      <>
        <PageHeader title="New document" />
        <Alert tone="warning" title="No published templates">
          Publish a template first.{" "}
          {ctx.permissions.has(PERMISSIONS.TEMPLATES_MANAGE) ? <ButtonLink href="/templates" size="sm" variant="secondary">Go to templates</ButtonLink> : "Ask a Company Admin to publish one."}
        </Alert>
      </>
    );
  }
  const raw = (sp.type ?? "").toUpperCase();
  const type = raw === "CONTRACT" ? "CONTRACT" : raw === "QUOTE" ? "QUOTE" : null;
  return (
    <>
      <PageHeader title="New document" description="Pick a template — DealDocs asks HubSpot (via Zapier) for the deal’s client, company and products." back={{ href: dealId ? `/deals/${dealId}/documents` : "/documents", label: dealId ? "Deal documents" : "Documents" }} />
      {dealId && existing.length ? (
        <div className="mb-4"><Alert tone="info">This deal already has {existing.length} document{existing.length > 1 ? "s" : ""}. <a className="font-semibold underline" href={`/deals/${dealId}/documents`}>View them</a></Alert></div>
      ) : null}
      <NewDocumentWizard templates={templates} initialType={type} initialDealId={dealId} integrationReady={isConfigured(integration)} defaultCurrency={ctx.organization.defaultCurrency} />
    </>
  );
}
