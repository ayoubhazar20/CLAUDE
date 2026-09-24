import type { DocumentType } from "@prisma/client";
import type { Tx } from "../db";
import { DEFAULT_NUMBERING, formatDocumentNumber, numberingScope } from "@/domain/numbering";

/**
 * Allocate the next document number atomically. Counters only ever move
 * forward, so numbers of deleted/archived documents are never reused.
 */
export async function allocateDocumentNumber(tx: Tx, organizationId: string, type: DocumentType, now = new Date()): Promise<string> {
  const setting = await tx.numberingSetting.findUnique({ where: { organizationId_documentType: { organizationId, documentType: type } } });
  const format = setting ?? DEFAULT_NUMBERING[type];
  const year = now.getUTCFullYear();
  const scope = numberingScope(format, year);
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await tx.$queryRaw<{ lastValue: number }[]>`
      INSERT INTO "numbering_counters" ("organizationId", "documentType", "scope", "lastValue")
      VALUES (${organizationId}::uuid, ${type}::"DocumentType", ${scope}, ${format.startNumber})
      ON CONFLICT ("organizationId", "documentType", "scope")
      DO UPDATE SET "lastValue" = GREATEST("numbering_counters"."lastValue" + 1, ${format.startNumber})
      RETURNING "lastValue"`;
    const value = Number(rows[0]!.lastValue);
    const number = formatDocumentNumber(format, value, year);
    // Guard against collisions after a format change (e.g. prefix changed back).
    const exists = await tx.document.findFirst({ where: { organizationId, number }, select: { id: true } });
    if (!exists) return number;
  }
  throw new Error("Could not allocate a unique document number");
}
