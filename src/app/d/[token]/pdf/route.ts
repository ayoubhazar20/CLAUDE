import { apiHandler } from "@/server/api";
import { publicPdf } from "@/server/documents/public-files";
import { fileResponse, readFile } from "@/server/storage/files";
import { NextResponse } from "next/server";

export const GET = apiHandler("public.pdf", async (_req: Request, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params;
  const file = await publicPdf(token);
  if (!file) return NextResponse.json({ error: { message: "The PDF is being generated. Please try again in a moment.", code: "PDF_PENDING" } }, { status: 409 });
  return fileResponse(file, await readFile(file), "attachment");
});
