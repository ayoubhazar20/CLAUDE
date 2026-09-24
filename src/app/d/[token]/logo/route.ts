import { apiHandler } from "@/server/api";
import { publicLogo } from "@/server/documents/public-files";
import { fileResponse, readFile } from "@/server/storage/files";

export const GET = apiHandler("public.logo", async (_req: Request, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params;
  const file = await publicLogo(token);
  return fileResponse(file, await readFile(file), "inline");
});
