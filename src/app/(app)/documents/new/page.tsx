import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { primaryConnection } from "@/server/hubspot/client";
import { Alert, ButtonLink, PageHeader } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";
import { NewDocumentWizard } from "./wizard";

export const metadata = { title: "New document" };

export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<{ type?: string; dealId?: string; portalId?: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.DOCUMENTS_CREATE);
  const sp = await searchParams;
  const [templates, connection] = await Promise.all([
    prisma.template.findMany({
      where: { organizationId: ctx.organizationId, status: "ACTIVE", publishedVersionId: { not: null } },
      select: { id: true, name: true, documentType: true, isDefault: true, description: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    }),
    primaryConnection(ctx.organizationId),
  ]);
  if (sp.portalId && connection && connection.portalId !== sp.portalId) {
    return (
      <>
        <PageHeader title="New document" />
        <Alert tone="error" title="Different HubSpot account">
          This deal belongs to a HubSpot account that is not connected to {ctx.organization.name}. Switch organization or connect this HubSpot account.
        </Alert>
      </>
    );
  }
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
  const type = sp.type === "CONTRACT" ? "CONTRACT" : sp.type === "QUOTE" ? "QUOTE" : null;
  return (
    <>
      <PageHeader title="New document" description="Pick a deal and a template — DealDocs imports the client, company and products for you." back={{ href: "/documents", label: "Documents" }} />
      <NewDocumentWizard
        templates={templates}
        initialType={type}
        initialDealId={sp.dealId && /^\d{1,30}$/.test(sp.dealId) ? sp.dealId : null}
        hubspotConnected={connection?.status === "CONNECTED"}
        defaultCurrency={ctx.organization.defaultCurrency}
      />
    </>
  );
}
