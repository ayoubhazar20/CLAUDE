import { apiHandler } from "@/server/api";
import { requireOrgApi } from "@/server/auth/context";
import { ValidationError } from "@/server/errors";
import { addAttachment, attachmentVisibilitySchema } from "@/server/services/attachments";
import { enforceRateLimit } from "@/server/security/rate-limit";

export const POST = apiHandler("attachments.upload", async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireOrgApi();
  const { id } = await params;
  await enforceRateLimit(`upload:${ctx.user.id}`, 30, 600);
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > 16 * 1024 * 1024) throw new ValidationError("The file is too large (max 15 MB).");
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("No file uploaded.");
  const visibility = attachmentVisibilitySchema.parse(form.get("visibility") ?? "INTERNAL");
  const attachment = await addAttachment(ctx, id, { name: file.name, data: Buffer.from(await file.arrayBuffer()) }, visibility);
  return { attachment: { id: attachment.id } };
});
