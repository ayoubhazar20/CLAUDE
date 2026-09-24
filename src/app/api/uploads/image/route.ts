import { apiHandler } from "@/server/api";
import { assertWritable, requireOrgApi } from "@/server/auth/context";
import { ValidationError } from "@/server/errors";
import { detectAndValidate, saveFile } from "@/server/storage/files";
import { assertWithinLimit } from "@/server/services/billing";
import { enforceRateLimit } from "@/server/security/rate-limit";

/** Image upload for template / document image blocks (PNG or JPEG only). */
export const POST = apiHandler("uploads.image", async (req: Request) => {
  const ctx = await requireOrgApi();
  assertWritable(ctx);
  await enforceRateLimit(`upload:${ctx.user.id}`, 30, 600);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("No file uploaded.");
  const data = Buffer.from(await file.arrayBuffer());
  const contentType = detectAndValidate(data, file.name, "image");
  await assertWithinLimit(ctx.organizationId, "storage", data.length);
  const stored = await saveFile({ organizationId: ctx.organizationId, kind: "IMAGE", filename: file.name, contentType, data, createdById: ctx.user.id });
  return { fileId: stored.id };
});
