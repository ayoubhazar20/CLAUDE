import { NextResponse } from "next/server";
import { apiHandler } from "@/server/api";
import { publicVersionPdf } from "@/server/documents/public-files";
import { fileResponse, readFile } from "@/server/storage/files";

/** Stable per-version PDF URL (mirrored to HubSpot as file_url). */
export const GET = apiHandler("public.versionPdf", async (_req: Request, { params }: { params: Promise<{ token: string; file: string }> }) => {
  const { token, file } = await params;
  const stored = await publicVersionPdf(token, file);
  if (!stored) return NextResponse.json({ error: { message: "The PDF is being generated. Please try again in a moment.", code: "PDF_PENDING" } }, { status: 409 });
  return fileResponse(stored, await readFile(stored), "inline");
});
