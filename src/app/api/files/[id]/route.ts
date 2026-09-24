import { apiHandler } from "@/server/api";
import { requireOrgApi } from "@/server/auth/context";
import { fileForUser } from "@/server/services/attachments";
import { fileResponse, readFile } from "@/server/storage/files";

/** Authenticated file download — tenant and document access are enforced. */
export const GET = apiHandler("files.get", async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireOrgApi();
  const { id } = await params;
  const file = await fileForUser(ctx, id);
  return fileResponse(file, await readFile(file), file.contentType.startsWith("image/") ? "inline" : "attachment");
});
