import { apiHandler } from "@/server/api";
import { requireOrgApi } from "@/server/auth/context";
import { loadDocumentForView } from "@/server/documents/access";

/** Status of the HubSpot deal data requested through Zapier (polled by the editor). */
export const GET = apiHandler("documents.dealData", async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireOrgApi();
  const { id } = await params;
  const doc = await loadDocumentForView(ctx, id);
  return { status: doc.dealDataStatus, requestedAt: doc.dealDataRequestedAt };
});
