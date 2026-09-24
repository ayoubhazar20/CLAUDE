import type { OrganizationStatus } from "@prisma/client";

export const statusTone = (s: OrganizationStatus) => (s === "ACTIVE" ? "green" : s === "PENDING_APPROVAL" ? "amber" : s === "SUSPENDED" || s === "REJECTED" ? "red" : "gray") as "green" | "amber" | "red" | "gray";
