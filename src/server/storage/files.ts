import crypto from "node:crypto";
import type { FileKind, StoredFile } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { ValidationError } from "../errors";
import { sha256Hex } from "../security/crypto";
import { storage } from "./index";

/** File type policy: validated by magic bytes, never by the client-provided type alone. */
interface Signature {
  mime: string;
  ext: string[];
  test: (b: Buffer) => boolean;
}
const SIGNATURES: Signature[] = [
  { mime: "application/pdf", ext: ["pdf"], test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { mime: "image/png", ext: ["png"], test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: ["jpg", "jpeg"], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: ["gif"], test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { mime: "image/webp", ext: ["webp"], test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ["docx"],
    test: (b) => b[0] === 0x50 && b[1] === 0x4b,
  },
  {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ["xlsx"],
    test: (b) => b[0] === 0x50 && b[1] === 0x4b,
  },
  {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: ["pptx"],
    test: (b) => b[0] === 0x50 && b[1] === 0x4b,
  },
  { mime: "text/plain", ext: ["txt", "csv"], test: (b) => !b.subarray(0, 4096).includes(0) },
];

export const UPLOAD_POLICIES: Record<"attachment" | "logo" | "image", { maxBytes: number; mimes: string[] }> = {
  attachment: {
    maxBytes: 15 * 1024 * 1024,
    mimes: SIGNATURES.map((s) => s.mime),
  },
  logo: { maxBytes: 2 * 1024 * 1024, mimes: ["image/png", "image/jpeg"] },
  // PDF embedding supports PNG/JPEG only, so template images are restricted to those.
  image: { maxBytes: 5 * 1024 * 1024, mimes: ["image/png", "image/jpeg"] },
};

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  return cleaned || "file";
}

/** Returns the detected MIME type or throws a ValidationError. */
export function detectAndValidate(buffer: Buffer, filename: string, policy: keyof typeof UPLOAD_POLICIES): string {
  const rules = UPLOAD_POLICIES[policy];
  if (buffer.length === 0) throw new ValidationError("The file is empty.");
  if (buffer.length > rules.maxBytes) throw new ValidationError(`The file is too large (max ${Math.round(rules.maxBytes / 1024 / 1024)} MB).`);
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const match = SIGNATURES.find((s) => s.ext.includes(ext) && s.test(buffer));
  if (!match || !rules.mimes.includes(match.mime)) {
    throw new ValidationError("This file type is not allowed.");
  }
  return match.mime;
}

/**
 * Malware scanning hook. Plug an AV service (e.g. ClamAV) here; files are also
 * never executed, stored outside the web root and served as downloads.
 */
export async function scanForMalware(_buffer: Buffer): Promise<void> {
  // No scanner configured by default.
}

export async function saveFile(
  params: { organizationId: string | null; kind: FileKind; filename: string; contentType: string; data: Buffer; createdById?: string | null },
  tx: Tx = prisma,
): Promise<StoredFile> {
  await scanForMalware(params.data);
  const id = crypto.randomUUID();
  const storageKey = `${params.organizationId ?? "platform"}/${params.kind.toLowerCase()}/${id}`;
  await storage().put(storageKey, params.data, params.contentType);
  return tx.storedFile.create({
    data: {
      id,
      organizationId: params.organizationId,
      kind: params.kind,
      storageKey,
      filename: sanitizeFilename(params.filename),
      contentType: params.contentType,
      size: params.data.length,
      checksum: sha256Hex(params.data),
      createdById: params.createdById ?? null,
    },
  });
}

export async function readFile(file: Pick<StoredFile, "storageKey">): Promise<Buffer> {
  return storage().get(file.storageKey);
}

export function fileResponse(file: StoredFile, data: Buffer, disposition: "inline" | "attachment" = "attachment"): Response {
  const inlineSafe = disposition === "inline" && (file.contentType.startsWith("image/") || file.contentType === "application/pdf");
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(data.length),
      "Content-Disposition": `${inlineSafe ? "inline" : "attachment"}; filename="${file.filename.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=300",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
