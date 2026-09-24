import { apiHandler, readJson } from "@/server/api";
import { requireOrgApi } from "@/server/auth/context";
import { saveTemplateDraft } from "@/server/services/templates";

export const PUT = apiHandler("templates.save", async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireOrgApi();
  const { id } = await params;
  const body = (await readJson(req, 2_000_000)) as Parameters<typeof saveTemplateDraft>[2];
  const version = await saveTemplateDraft(ctx, id, body);
  return { version: version.version, updatedAt: version.updatedAt.toISOString(), status: version.status };
});
