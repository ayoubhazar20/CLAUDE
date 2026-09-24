import { prisma } from "@/server/db";
import { NotFoundError } from "@/server/errors";
import { zapierRoute } from "@/server/integrations/route";
import { buildDocumentRecord } from "@/server/integrations/outbound";

/** Zapier lookup: current mirror record of one document (scoped to the authenticated organization). */
export const GET = zapierRoute("DOCUMENT_LOOKUP", async (integration, _body, _meta, _req, params) => {
  const id = params.id ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("Document");
  const doc = await prisma.document.findFirst({ where: { id, organizationId: integration.organizationId }, select: { id: true } });
  if (!doc) throw new NotFoundError("Document");
  return { document: await buildDocumentRecord(doc.id) };
});
