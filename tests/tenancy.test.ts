import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import type { OrgContext } from "@/server/auth/context";
import { createDocument, saveDraft, publishDocument, duplicateDocument, setArchived } from "@/server/documents/service";
import { loadDocumentForView } from "@/server/documents/access";
import { listDocuments, listFiltersSchema } from "@/server/documents/queries";
import { fileForUser } from "@/server/services/attachments";
import { inviteUser, setMembershipStatus, createTeam, setTeamMember } from "@/server/services/members";
import { saveTemplateDraft, publishTemplate, getTemplateForEditing } from "@/server/services/templates";
import { saveIntegrationSettings } from "@/server/integrations/config";
import { systemRole } from "@/server/services/roles";
import { addMember, createActiveOrg, processJobs, resetDatabase, templateId, useOutbox } from "./helpers";

async function newQuote(ctx: OrgContext) {
  return createDocument(ctx, { type: "QUOTE", templateId: await templateId(ctx.organizationId, "QUOTE") });
}

describe("tenant isolation and permissions", () => {
  useOutbox();
  let a: Awaited<ReturnType<typeof createActiveOrg>>;
  let b: Awaited<ReturnType<typeof createActiveOrg>>;
  let docA: string;
  let docB: string;

  beforeAll(async () => {
    await resetDatabase();
    a = await createActiveOrg("Org A");
    b = await createActiveOrg("Org B");
    docA = (await newQuote(a.adminCtx)).id;
    docB = (await newQuote(b.adminCtx)).id;
  });

  it("numbers are unique per organization and never reused", async () => {
    const numbers = await prisma.document.findMany({ where: { id: { in: [docA, docB] } }, select: { number: true } });
    expect(numbers[0]!.number).toBe(numbers[1]!.number); // independent sequences
    const second = await newQuote(a.adminCtx);
    await setArchived(a.adminCtx, second.id, true);
    const third = await newQuote(a.adminCtx);
    expect(third.number.endsWith("000003")).toBe(true);
  });

  it("a user from organization A cannot read organization B's document by id (IDOR)", async () => {
    await expect(loadDocumentForView(a.adminCtx, docB)).rejects.toThrow(/not found/);
    await expect(saveDraft(a.adminCtx, docB, { baseUpdatedAt: new Date().toISOString(), title: "pwned" })).rejects.toThrow(/not found/);
    await expect(publishDocument(a.adminCtx, docB)).rejects.toThrow(/not found/);
    await expect(duplicateDocument(a.adminCtx, docB)).rejects.toThrow(/not found/);
    const list = await listDocuments(a.adminCtx, listFiltersSchema.parse({}));
    expect(list.rows.every((r) => r.organizationId === a.org.id)).toBe(true);
  });

  it("cross-tenant templates, files and roles are rejected", async () => {
    const tplB = await templateId(b.org.id, "QUOTE");
    await expect(createDocument(a.adminCtx, { type: "QUOTE", templateId: tplB })).rejects.toThrow(/published template/);
    await expect(getTemplateForEditing(a.adminCtx, tplB)).rejects.toThrow(/not found/);
    const pdfFile = await prisma.storedFile.create({ data: { organizationId: b.org.id, kind: "LOGO", storageKey: `x/${Date.now()}`, filename: "l.png", contentType: "image/png", size: 1, checksum: "0" } });
    await expect(fileForUser(a.adminCtx, pdfFile.id)).rejects.toThrow(/not found/);
    const customRole = await prisma.role.create({ data: { organizationId: b.org.id, key: "custom", name: "Custom B" } });
    await expect(inviteUser(a.adminCtx, { email: "x@y.test", roleId: customRole.id })).rejects.toThrow(/Unknown role/);
  });

  it("a user sees only their own documents; a viewer is read-only", async () => {
    const user1 = await addMember(a.org.id, "user", "User One");
    const user2 = await addMember(a.org.id, "user", "User Two");
    const viewer = await addMember(a.org.id, "viewer", "Viewer");
    const own = await newQuote(user1.ctx);
    await expect(loadDocumentForView(user2.ctx, own.id)).rejects.toThrow(/not found/);
    await expect(loadDocumentForView(user1.ctx, docA)).rejects.toThrow(/not found/); // admin's doc
    expect((await loadDocumentForView(viewer.ctx, own.id)).id).toBe(own.id);
    await expect(newQuote(viewer.ctx)).rejects.toThrow(/permission/);
    const version = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: own.id } });
    await expect(saveDraft(viewer.ctx, own.id, { baseUpdatedAt: version.updatedAt.toISOString(), title: "x" })).rejects.toThrow(/cannot edit/);
    await expect(saveIntegrationSettings(user1.ctx, { enabled: true, hubspotObjectTypeId: "2-1", webhookUrl: "https://hooks.zapier.com/x", dealPropertyNames: {}, statusMapping: {}, propertyVariableMap: {} })).rejects.toThrow(/permission/);
    await expect(inviteUser(user1.ctx, { email: "z@z.test", roleId: (await systemRole("admin")).id })).rejects.toThrow(/permission/);
  });

  it("a manager sees and edits team documents only", async () => {
    const manager = await addMember(a.org.id, "manager", "Manager");
    const member = await addMember(a.org.id, "user", "Team Member");
    const outsider = await addMember(a.org.id, "user", "Outsider");
    const team = await createTeam(a.adminCtx, "Sales East");
    await setTeamMember(a.adminCtx, team.id, manager.membershipId, true, true);
    await setTeamMember(a.adminCtx, team.id, member.membershipId, true);
    const teamDoc = await newQuote(member.ctx);
    const outsiderDoc = await newQuote(outsider.ctx);
    expect((await loadDocumentForView(manager.ctx, teamDoc.id)).id).toBe(teamDoc.id);
    await expect(loadDocumentForView(manager.ctx, outsiderDoc.id)).rejects.toThrow(/not found/);
    const v = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: teamDoc.id } });
    await expect(saveDraft(manager.ctx, teamDoc.id, { baseUpdatedAt: v.updatedAt.toISOString(), title: "Edited by manager" })).resolves.toBeTruthy();
  });

  it("disabled members lose access; the last admin cannot be disabled", async () => {
    const u = await addMember(a.org.id, "user", "Leaving");
    await setMembershipStatus(a.adminCtx, u.membershipId, false);
    const { buildOrgContext } = await import("@/server/auth/context");
    expect(await buildOrgContext({ userId: u.userId, organizationId: a.org.id })).toBeNull();
    await expect(setMembershipStatus(a.adminCtx, a.adminCtx.membershipId!, false)).rejects.toThrow(/own account/);
  });

  it("support view is read-only", async () => {
    const { buildOrgContext } = await import("@/server/auth/context");
    const support = (await buildOrgContext({ userId: a.platform.id, organizationId: b.org.id, supportView: true }))!;
    expect(support.isSupportView).toBe(true);
    expect((await loadDocumentForView(support, docB)).id).toBe(docB);
    await expect(newQuote(support)).rejects.toThrow(/read-only/);
    // Non platform-admins can never get a support view.
    expect(await buildOrgContext({ userId: a.admin.id, organizationId: b.org.id, supportView: true })).toBeNull();
  });

  it("template edits never change existing documents (versioned templates)", async () => {
    const tplId = await templateId(a.org.id, "QUOTE");
    const before = await newQuote(a.adminCtx);
    const beforeVersion = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: before.id } });
    const { blocks, settings, version } = await getTemplateForEditing(a.adminCtx, tplId);
    blocks.unshift({ id: "b_newheading01", type: "heading", locked: false, condition: null, props: { text: "NEW TEMPLATE HEADING", level: 1, align: "left" } });
    await saveTemplateDraft(a.adminCtx, tplId, { blocks, settings });
    const draft = await getTemplateForEditing(a.adminCtx, tplId);
    expect(draft.version.version).toBe(version.version + 1);
    await publishTemplate(a.adminCtx, tplId);
    const oldTemplateVersion = await prisma.templateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(JSON.stringify(oldTemplateVersion.content)).not.toContain("NEW TEMPLATE HEADING");
    const unchanged = await prisma.documentVersion.findUniqueOrThrow({ where: { id: beforeVersion.id } });
    expect(JSON.stringify(unchanged.content)).not.toContain("NEW TEMPLATE HEADING");
    const after = await newQuote(a.adminCtx);
    const afterVersion = await prisma.documentVersion.findFirstOrThrow({ where: { documentId: after.id } });
    expect(JSON.stringify(afterVersion.content)).toContain("NEW TEMPLATE HEADING");
    await processJobs();
  });
});
