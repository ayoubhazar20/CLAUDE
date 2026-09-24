import { apiHandler, readJson } from "@/server/api";
import { requireOrgApi } from "@/server/auth/context";
import { saveDraft } from "@/server/documents/service";
import { enforceRateLimit } from "@/server/security/rate-limit";

/** Autosave endpoint for the document editor. */
export const PUT = apiHandler("documents.autosave", async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireOrgApi();
  const { id } = await params;
  await enforceRateLimit(`autosave:${ctx.user.id}`, 240, 60);
  const body = (await readJson(req, 2_000_000)) as Parameters<typeof saveDraft>[2];
  return saveDraft(ctx, id, body);
});
