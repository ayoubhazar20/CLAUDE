import type { DocumentStatus, DocumentType } from "@prisma/client";

export const QUOTE_STATUSES: DocumentStatus[] = [
  "DRAFT", "PUBLISHED", "SENT", "VIEWED", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED",
];
export const CONTRACT_STATUSES: DocumentStatus[] = [
  "DRAFT", "PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED",
];

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  SENT: "Sent",
  VIEWED: "Viewed",
  AWAITING_SIGNATURE: "Awaiting Signature",
  ACCEPTED: "Accepted",
  SIGNED: "Signed",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

/** Statuses in which the client can still act on the published version. */
export const OPEN_STATUSES: DocumentStatus[] = ["PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE"];
/** Final outcomes of a published version. */
export const COMPLETED_STATUSES: DocumentStatus[] = ["ACCEPTED", "SIGNED"];
export const TERMINAL_STATUSES: DocumentStatus[] = ["ACCEPTED", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED"];

const TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  DRAFT: ["PUBLISHED", "CANCELLED"],
  PUBLISHED: ["PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE", "ACCEPTED", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED"],
  SENT: ["PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE", "ACCEPTED", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED"],
  VIEWED: ["PUBLISHED", "SENT", "AWAITING_SIGNATURE", "ACCEPTED", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED"],
  AWAITING_SIGNATURE: ["PUBLISHED", "SIGNED", "REJECTED", "EXPIRED", "CANCELLED"],
  // A revision of a completed / closed document may be published again.
  ACCEPTED: ["PUBLISHED"],
  SIGNED: ["PUBLISHED"],
  REJECTED: ["PUBLISHED"],
  EXPIRED: ["PUBLISHED"],
  CANCELLED: ["PUBLISHED"],
};

export function allowedStatuses(type: DocumentType): DocumentStatus[] {
  return type === "QUOTE" ? QUOTE_STATUSES : CONTRACT_STATUSES;
}

export function canTransition(type: DocumentType, from: DocumentStatus, to: DocumentStatus): boolean {
  if (!allowedStatuses(type).includes(to)) return false;
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from: DocumentStatus, to: DocumentStatus) {
    super(`Invalid document status transition ${from} → ${to}`);
  }
}

export function assertTransition(type: DocumentType, from: DocumentStatus, to: DocumentStatus) {
  if (!canTransition(type, from, to)) throw new InvalidTransitionError(from, to);
}

/** Viewing/sending only moves the status forward, never backwards (e.g. VIEWED stays VIEWED on resend). */
const PROGRESS_ORDER: DocumentStatus[] = ["DRAFT", "PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE"];
export function isForwardProgress(from: DocumentStatus, to: DocumentStatus): boolean {
  const a = PROGRESS_ORDER.indexOf(from);
  const b = PROGRESS_ORDER.indexOf(to);
  return a >= 0 && b > a;
}

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = { QUOTE: "Quote", CONTRACT: "Contract" };
