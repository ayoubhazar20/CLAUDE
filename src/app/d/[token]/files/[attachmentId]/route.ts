import { apiHandler } from "@/server/api";
import { publicAttachment } from "@/server/documents/public-files";
import { fileResponse, readFile } from "@/server/storage/files";

export const GET = apiHandler("public.attachment", async (_req: Request, { params }: { params: Promise<{ token: string; attachmentId: string }> }) => {
  const { token, attachmentId } = await params;
  const file = await publicAttachment(token, attachmentId);
  return fileResponse(file, await readFile(file), "attachment");
});
