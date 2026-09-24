import { notFound } from "next/navigation";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { loadDocumentForView } from "@/server/documents/access";
import { resolveFromRows } from "@/server/documents/render-input";
import { NotFoundError } from "@/server/errors";
import { DocumentFrame } from "@/components/document-frame";
import { Alert, ButtonLink } from "@/components/ui";
import { renderDocumentHtml } from "@/domain/render-html";

export const metadata = { title: "Preview" };

export default async function PreviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ version?: string }> }) {
  const ctx = await requireOrgPage();
  const { id } = await params;
  const sp = await searchParams;
  let doc;
  try {
    doc = await loadDocumentForView(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const versionNumber = sp.version ? Number(sp.version) : null;
  const version = versionNumber
    ? await prisma.documentVersion.findFirst({ where: { documentId: doc.id, versionNumber, organizationId: ctx.organizationId } })
    : await prisma.documentVersion.findFirst({ where: { id: doc.draftVersionId ?? doc.publishedVersionId ?? "00000000-0000-0000-0000-000000000000" } });
  if (!version) notFound();
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const [lines, signatures, recipients] = await Promise.all([
    prisma.documentLineItem.findMany({ where: { versionId: version.id } }),
    prisma.signature.findMany({ where: { versionId: version.id } }),
    version.lockedAt ? prisma.documentRecipient.findMany({ where: { documentId: doc.id } }) : Promise.resolve(null),
  ]);
  const snapshotIds = new Set(((version.data as { recipients?: { id: string }[] }).recipients ?? []).map((r) => r.id));
  const { resolved } = resolveFromRows({
    document: doc,
    version,
    lineItems: lines,
    organization,
    recipients: recipients ? recipients.filter((r) => snapshotIds.has(r.id)) : null,
    signatures,
    logoUrl: organization.logoFileId ? `/api/files/${organization.logoFileId}` : null,
    imageUrl: (fileId) => `/api/files/${fileId}`,
    showMissingVariables: !version.lockedAt,
  });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">Preview · {doc.number} · version {version.versionNumber} ({version.status.toLowerCase()})</p>
        </div>
        <div className="flex gap-2">
          <ButtonLink variant="secondary" href={`/documents/${doc.id}`}>Back</ButtonLink>
          {doc.draftVersionId === version.id ? <ButtonLink href={`/documents/${doc.id}/edit`}>Edit</ButtonLink> : null}
        </div>
      </div>
      {!version.lockedAt ? <div className="mb-4"><Alert tone="info">This is an unpublished draft. Highlighted placeholders are variables without a value.</Alert></div> : null}
      <div className="mx-auto max-w-4xl rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-10">
        <DocumentFrame html={renderDocumentHtml(resolved)} />
      </div>
    </>
  );
}
