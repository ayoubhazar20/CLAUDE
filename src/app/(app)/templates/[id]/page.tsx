import { notFound } from "next/navigation";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { getTemplateForEditing } from "@/server/services/templates";
import { variableCatalog } from "@/server/services/custom-fields";
import { organizationForRender } from "@/server/documents/render-input";
import { NotFoundError } from "@/server/errors";
import { TemplateBuilder } from "@/components/editor/template-builder";
import { PERMISSIONS } from "@/domain/permissions";

export const metadata = { title: "Template builder" };

export default async function TemplateBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.TEMPLATES_VIEW);
  const { id } = await params;
  let data;
  try {
    data = await getTemplateForEditing(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const [organization, variables] = await Promise.all([prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }), variableCatalog(ctx.organizationId)]);
  return (
    <TemplateBuilder
      templateId={data.template.id}
      name={data.template.name}
      documentType={data.template.documentType}
      versionNumber={data.version.version}
      versionStatus={data.version.status}
      updatedAt={data.version.updatedAt.toISOString()}
      blocks={data.blocks}
      settings={data.settings}
      organization={organizationForRender(organization, organization.logoFileId ? `/api/files/${organization.logoFileId}` : null)}
      variables={variables}
      readOnly={!ctx.permissions.has(PERMISSIONS.TEMPLATES_MANAGE) || ctx.isSupportView || data.template.status === "ARCHIVED"}
    />
  );
}
