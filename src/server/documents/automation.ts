import type { AutomationEvent, DocumentType } from "@prisma/client";

/** Maps document lifecycle moments to configurable HubSpot pipeline automation events. */
export function automationEvent(type: DocumentType, what: "PUBLISHED" | "SENT" | "VIEWED" | "ACCEPTED" | "REJECTED" | "SIGNED"): AutomationEvent | null {
  const map: Record<string, AutomationEvent> = {
    QUOTE_PUBLISHED: "QUOTE_PUBLISHED",
    QUOTE_SENT: "QUOTE_SENT",
    QUOTE_VIEWED: "QUOTE_VIEWED",
    QUOTE_ACCEPTED: "QUOTE_ACCEPTED",
    QUOTE_REJECTED: "QUOTE_REJECTED",
    QUOTE_SIGNED: "QUOTE_ACCEPTED",
    CONTRACT_PUBLISHED: "CONTRACT_PUBLISHED",
    CONTRACT_SENT: "CONTRACT_SENT",
    CONTRACT_VIEWED: "CONTRACT_VIEWED",
    CONTRACT_SIGNED: "CONTRACT_SIGNED",
    CONTRACT_REJECTED: "CONTRACT_REJECTED",
  };
  return map[`${type}_${what}`] ?? null;
}
