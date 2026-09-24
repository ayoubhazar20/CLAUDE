import type { DocumentType } from "@prisma/client";

export interface NumberingFormat {
  prefix: string;
  includeYear: boolean;
  padding: number;
  startNumber: number;
}

export const DEFAULT_NUMBERING: Record<DocumentType, NumberingFormat> = {
  QUOTE: { prefix: "Q", includeYear: true, padding: 6, startNumber: 1 },
  CONTRACT: { prefix: "C", includeYear: true, padding: 6, startNumber: 1 },
};

export function formatDocumentNumber(format: NumberingFormat, value: number, year: number): string {
  const seq = String(value).padStart(Math.max(1, Math.min(format.padding, 12)), "0");
  const parts = [format.prefix.trim()].filter(Boolean);
  if (format.includeYear) parts.push(String(year));
  parts.push(seq);
  return parts.join("-");
}

export function numberingScope(format: NumberingFormat, year: number): number {
  return format.includeYear ? year : 0;
}
