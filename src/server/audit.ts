import type { ActorType, Prisma } from "@prisma/client";
import { prisma, type Tx } from "./db";

/**
 * Immutable audit trail (the table is append-only at the database level).
 * Callers must never pass secrets; values are additionally scrubbed here.
 */
const SECRET_KEYS = /pass(word)?|secret|token|hash|otp|code|authorization|cookie|refresh|access/i;

export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrub(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 5000) return `${value.slice(0, 5000)}…`;
  return value;
}

export const AUDIT_ACTIONS = [
  "USER_REGISTERED",
  "USER_EMAIL_VERIFIED",
  "USER_LOGGED_IN",
  "USER_LOGIN_FAILED",
  "USER_LOGGED_OUT",
  "USER_PASSWORD_RESET_REQUESTED",
  "USER_PASSWORD_RESET",
  "USER_INVITED",
  "USER_INVITATION_ACCEPTED",
  "USER_INVITATION_REVOKED",
  "USER_DISABLED",
  "USER_ENABLED",
  "USER_ROLE_CHANGED",
  "USER_SUSPENDED",
  "USER_REACTIVATED",
  "TERMS_ACCEPTED",
  "ORGANIZATION_CREATED",
  "ORGANIZATION_SUBMITTED",
  "ORGANIZATION_APPROVED",
  "ORGANIZATION_REJECTED",
  "ORGANIZATION_SUSPENDED",
  "ORGANIZATION_REACTIVATED",
  "ORGANIZATION_UPDATED",
  "ORGANIZATION_PLAN_CHANGED",
  "ONBOARDING_UPDATED",
  "SUPPORT_VIEW_OPENED",
  "SUPPORT_VIEW_CLOSED",
  "TEAM_CREATED",
  "TEAM_UPDATED",
  "TEAM_ARCHIVED",
  "ROLE_UPDATED",
  "NUMBERING_UPDATED",
  "HUBSPOT_CONNECTED",
  "HUBSPOT_DISCONNECTED",
  "HUBSPOT_SETTINGS_UPDATED",
  "PROPERTY_MAPPING_UPDATED",
  "PIPELINE_MAPPING_UPDATED",
  "TEMPLATE_CREATED",
  "TEMPLATE_UPDATED",
  "TEMPLATE_PUBLISHED",
  "TEMPLATE_DUPLICATED",
  "TEMPLATE_ARCHIVED",
  "TEMPLATE_RESTORED",
  "TEMPLATE_SET_DEFAULT",
  "EMAIL_TEMPLATE_UPDATED",
  "CUSTOM_FIELD_UPDATED",
  "DOCUMENT_CREATED",
  "DOCUMENT_UPDATED",
  "DOCUMENT_PUBLISHED",
  "DOCUMENT_SENT",
  "DOCUMENT_REVISED",
  "DOCUMENT_DUPLICATED",
  "DOCUMENT_CONVERTED",
  "DOCUMENT_ARCHIVED",
  "DOCUMENT_RESTORED",
  "DOCUMENT_CANCELLED",
  "DOCUMENT_ACCEPTED",
  "DOCUMENT_REJECTED",
  "DOCUMENT_SIGNED",
  "DOCUMENT_EXPIRED",
  "DOCUMENT_PRIMARY_SET",
  "DOCUMENT_OWNER_CHANGED",
  "ATTACHMENT_ADDED",
  "ATTACHMENT_ARCHIVED",
  "PLAN_UPDATED",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  organizationId?: string | null;
  userId?: string | null;
  actorType?: ActorType;
  actorLabel?: string | null;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  ip?: string | null;
  userAgent?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry, tx: Tx = prisma): Promise<void> {
  await tx.auditLog.create({
    data: {
      organizationId: entry.organizationId ?? null,
      userId: entry.userId ?? null,
      actorType: entry.actorType ?? (entry.userId ? "USER" : "SYSTEM"),
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      previousValue: entry.previousValue === undefined ? undefined : (scrub(entry.previousValue) as Prisma.InputJsonValue),
      newValue: entry.newValue === undefined ? undefined : (scrub(entry.newValue) as Prisma.InputJsonValue),
      metadata: (scrub(entry.metadata ?? {}) as Prisma.InputJsonValue) ?? {},
    },
  });
}
