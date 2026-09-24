import type { DocumentStatus } from "@prisma/client";
import { Badge } from "./ui";
import { STATUS_LABELS } from "@/domain/status";

const tones: Record<DocumentStatus, "gray" | "blue" | "indigo" | "amber" | "green" | "red" | "purple"> = {
  DRAFT: "gray",
  PUBLISHED: "blue",
  SENT: "indigo",
  VIEWED: "purple",
  AWAITING_SIGNATURE: "amber",
  ACCEPTED: "green",
  SIGNED: "green",
  REJECTED: "red",
  EXPIRED: "gray",
  CANCELLED: "gray",
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  return <Badge tone={tones[status]}>{STATUS_LABELS[status]}</Badge>;
}
