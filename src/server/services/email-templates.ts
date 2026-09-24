import type { EmailTemplateKind } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { DEFAULT_EMAIL_TEMPLATES } from "./starter-content";
import { PERMISSIONS } from "@/domain/permissions";

export const emailTemplateSchema = z.object({
  kind: z.enum(["QUOTE_SEND", "CONTRACT_SEND", "REMINDER", "SIGNED_DOCUMENT"]),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(10000),
});

export async function listEmailTemplates(ctx: OrgContext) {
  const rows = await prisma.emailTemplate.findMany({ where: { organizationId: ctx.organizationId, isDefault: true } });
  return (Object.keys(DEFAULT_EMAIL_TEMPLATES) as EmailTemplateKind[]).map((kind) => {
    const row = rows.find((r) => r.kind === kind);
    const fallback = DEFAULT_EMAIL_TEMPLATES[kind];
    return { kind, name: row?.name ?? fallback.name, subject: row?.subject ?? fallback.subject, body: row?.body ?? fallback.body, id: row?.id ?? null };
  });
}

export async function saveEmailTemplate(ctx: OrgContext, input: z.input<typeof emailTemplateSchema>) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.EMAIL_TEMPLATES_MANAGE);
  const data = emailTemplateSchema.parse(input);
  const existing = await prisma.emailTemplate.findFirst({ where: { organizationId: ctx.organizationId, kind: data.kind, isDefault: true } });
  const saved = existing
    ? await prisma.emailTemplate.update({ where: { id: existing.id }, data: { subject: data.subject, body: data.body } })
    : await prisma.emailTemplate.create({ data: { organizationId: ctx.organizationId, kind: data.kind, name: DEFAULT_EMAIL_TEMPLATES[data.kind].name, subject: data.subject, body: data.body, isDefault: true } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "EMAIL_TEMPLATE_UPDATED", entityType: "EmailTemplate", entityId: saved.id, previousValue: existing ? { subject: existing.subject } : null, newValue: { subject: data.subject } });
  return saved;
}
