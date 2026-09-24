import { notFound, redirect } from "next/navigation";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { loadDocumentForEdit } from "@/server/documents/access";
import { organizationForRender, parsePricingConfig } from "@/server/documents/render-input";
import { variableCatalog } from "@/server/services/custom-fields";
import { primaryConnection } from "@/server/hubspot/client";
import { AppError, NotFoundError } from "@/server/errors";
import { Alert, ButtonLink, PageHeader } from "@/components/ui";
import { DocumentEditor } from "@/components/editor/document-editor";
import { parseBlocks } from "@/domain/blocks";
import { parseDocumentData } from "@/domain/document-data";
import { PERMISSIONS } from "@/domain/permissions";

export const metadata = { title: "Edit document" };

export default async function EditDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgPage();
  const { id } = await params;
  let doc;
  try {
    doc = await loadDocumentForEdit(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof AppError && e.status === 403) redirect(`/documents/${id}`);
    throw e;
  }
  if (!doc.draftVersionId) {
    return (
      <>
        <PageHeader title={`Edit ${doc.number}`} back={{ href: `/documents/${doc.id}`, label: doc.number }} />
        <Alert tone="info" title="This version is published">
          To make changes, create a new revision from the document page. The published version stays available to the client until you publish the revision.
        </Alert>
        <div className="mt-4"><ButtonLink href={`/documents/${doc.id}`}>Back to document</ButtonLink></div>
      </>
    );
  }
  if (doc.archivedAt) redirect(`/documents/${doc.id}`);
  const [version, organization, customFields, variables, connection] = await Promise.all([
    prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.draftVersionId }, include: { lineItems: { orderBy: { position: "asc" } } } }),
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }),
    prisma.customFieldDefinition.findMany({ where: { organizationId: ctx.organizationId, archivedAt: null, appliesTo: { has: doc.type } }, orderBy: { label: "asc" } }),
    variableCatalog(ctx.organizationId),
    primaryConnection(ctx.organizationId),
  ]);
  return (
    <DocumentEditor
      documentId={doc.id}
      number={doc.number}
      type={doc.type}
      versionNumber={version.versionNumber}
      publicToken={doc.publicToken}
      acceptanceMode={doc.acceptanceMode}
      hasPublished={Boolean(doc.publishedVersionId)}
      initial={{
        title: doc.title,
        blocks: parseBlocks(version.content),
        data: parseDocumentData(version.data),
        lines: version.lineItems.map((l) => ({
          id: l.id,
          source: l.source,
          hubspotLineItemId: l.hubspotLineItemId,
          hubspotProductId: l.hubspotProductId,
          sku: l.sku,
          name: l.name,
          description: l.description,
          category: l.category,
          quantity: l.quantity.toString(),
          unitPrice: l.unitPrice.toString(),
          discountType: l.discountType,
          discountValue: l.discountValue.toString(),
          taxKeys: l.taxKeys,
          optional: l.optional,
        })),
        pricing: parsePricingConfig(version.pricingConfig),
        currency: version.currency,
        expiresAt: version.expiresAt ? version.expiresAt.toISOString().slice(0, 10) : null,
        updatedAt: version.updatedAt.toISOString(),
      }}
      organization={organizationForRender(organization, organization.logoFileId ? `/api/files/${organization.logoFileId}` : null)}
      timezone={organization.timezone}
      variables={variables}
      customFields={customFields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, required: f.required }))}
      hubspotConnected={connection?.status === "CONNECTED"}
      canPublish={ctx.permissions.has(PERMISSIONS.DOCUMENTS_PUBLISH)}
    />
  );
}
