import { apiHandler } from "@/server/api";
import { assertPermission, assertWritable, requireOrgApi } from "@/server/auth/context";
import { ValidationError } from "@/server/errors";
import { detectAndValidate, saveFile } from "@/server/storage/files";
import { updateBranding } from "@/server/services/organizations";
import { prisma } from "@/server/db";
import { PERMISSIONS } from "@/domain/permissions";

export const POST = apiHandler("uploads.logo", async (req: Request) => {
  const ctx = await requireOrgApi();
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.ORG_SETTINGS_MANAGE);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("No file uploaded.");
  const data = Buffer.from(await file.arrayBuffer());
  const contentType = detectAndValidate(data, file.name, "logo");
  const stored = await saveFile({ organizationId: ctx.organizationId, kind: "LOGO", filename: file.name, contentType, data, createdById: ctx.user.id });
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  await updateBranding(ctx, { brandColor: org.brandColor, logoFileId: stored.id });
  return { fileId: stored.id };
});
