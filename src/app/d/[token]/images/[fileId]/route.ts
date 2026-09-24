import { apiHandler } from "@/server/api";
import { publicImage } from "@/server/documents/public-files";
import { fileResponse, readFile } from "@/server/storage/files";

export const GET = apiHandler("public.image", async (_req: Request, { params }: { params: Promise<{ token: string; fileId: string }> }) => {
  const { token, fileId } = await params;
  const file = await publicImage(token, fileId);
  return fileResponse(file, await readFile(file), "inline");
});
