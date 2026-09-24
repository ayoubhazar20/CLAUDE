"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { formString, runAction } from "@/server/actions";
import { requireOrgApi } from "@/server/auth/context";
import {
  cancelDocument,
  changeOwner,
  convertQuoteToContract,
  createDocument,
  createRevision,
  discardDraft,
  duplicateDocument,
  publishDocument,
  setArchived,
  setPrimaryDocument,
} from "@/server/documents/service";
import { getEmailDraft, sendDocument } from "@/server/documents/send";
import { archiveAttachment, setAttachmentVisibility } from "@/server/services/attachments";
import type { ActionState } from "@/lib/action-state";

export async function createDocumentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let id = "";
  const result = await runAction("createDocument", async () => {
    const ctx = await requireOrgApi();
    const doc = await createDocument(ctx, {
      type: formString(form, "type") as "QUOTE" | "CONTRACT",
      templateId: formString(form, "templateId"),
      hubspotDealId: formString(form, "dealId") || null,
      contactId: formString(form, "contactId") || null,
      currency: formString(form, "currency") || undefined,
    });
    id = doc.id;
  });
  if (!result?.ok) return result;
  redirect(`/documents/${id}/edit`);
}

const idOf = (form: FormData) => z.string().uuid().parse(formString(form, "documentId"));

export async function publishAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("publish", async () => {
    const ctx = await requireOrgApi();
    const r = await publishDocument(ctx, idOf(form));
    return { ok: true, message: `Version ${r.versionNumber} published.`, data: r };
  });
}

export async function emailDraftAction(documentId: string, kind: "initial" | "reminder"): Promise<ActionState<Awaited<ReturnType<typeof getEmailDraft>>>> {
  return runAction("emailDraft", async () => {
    const ctx = await requireOrgApi();
    return { ok: true, data: await getEmailDraft(ctx, z.string().uuid().parse(documentId), kind) };
  });
}

export async function sendAction(input: { documentId: string; to: string[]; cc: string[]; subject: string; message: string; kind: "initial" | "reminder"; attachPdf: boolean }): Promise<ActionState> {
  return runAction("send", async () => {
    const ctx = await requireOrgApi();
    await sendDocument(ctx, z.string().uuid().parse(input.documentId), input);
    return { ok: true, message: input.kind === "reminder" ? "Reminder sent." : "Email sent." };
  });
}

/** Publish then return the composer draft (Publish & Send). */
export async function publishAndPrepareSendAction(documentId: string): Promise<ActionState<Awaited<ReturnType<typeof getEmailDraft>>>> {
  return runAction("publishAndSend", async () => {
    const ctx = await requireOrgApi();
    const id = z.string().uuid().parse(documentId);
    await publishDocument(ctx, id);
    return { ok: true, data: await getEmailDraft(ctx, id, "initial") };
  });
}

export async function revisionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = idOf(form);
  const result = await runAction("revision", async () => {
    const ctx = await requireOrgApi();
    await createRevision(ctx, id, { fromLatestTemplate: formString(form, "fromLatestTemplate") === "1" });
  });
  if (!result?.ok) return result;
  redirect(`/documents/${id}/edit`);
}

export async function discardDraftAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("discardDraft", async () => {
    const ctx = await requireOrgApi();
    await discardDraft(ctx, idOf(form));
    return { ok: true, message: "Draft discarded." };
  });
}

export async function duplicateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let newId = "";
  const result = await runAction("duplicate", async () => {
    const ctx = await requireOrgApi();
    newId = (await duplicateDocument(ctx, idOf(form))).id;
  });
  if (!result?.ok) return result;
  redirect(`/documents/${newId}/edit`);
}

export async function convertAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let newId = "";
  const result = await runAction("convert", async () => {
    const ctx = await requireOrgApi();
    newId = (await convertQuoteToContract(ctx, idOf(form), z.string().uuid().parse(formString(form, "templateId")))).id;
  });
  if (!result?.ok) return result;
  redirect(`/documents/${newId}/edit`);
}

export async function archiveAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("archive", async () => {
    const ctx = await requireOrgApi();
    const archived = formString(form, "archived") !== "0";
    await setArchived(ctx, idOf(form), archived);
    return { ok: true, message: archived ? "Document archived." : "Document restored." };
  });
}

export async function cancelAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("cancel", async () => {
    const ctx = await requireOrgApi();
    await cancelDocument(ctx, idOf(form), formString(form, "reason") || undefined);
    return { ok: true, message: "Document cancelled." };
  });
}

export async function primaryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("primary", async () => {
    const ctx = await requireOrgApi();
    await setPrimaryDocument(ctx, idOf(form));
    return { ok: true, message: "Marked as primary document for the deal." };
  });
}

export async function changeOwnerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("changeOwner", async () => {
    const ctx = await requireOrgApi();
    await changeOwner(ctx, idOf(form), z.string().uuid().parse(formString(form, "ownerId")));
    return { ok: true, message: "Owner changed." };
  });
}

export async function attachmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("attachment", async () => {
    const ctx = await requireOrgApi();
    const id = z.string().uuid().parse(formString(form, "attachmentId"));
    const op = formString(form, "op");
    if (op === "archive") await archiveAttachment(ctx, id);
    else await setAttachmentVisibility(ctx, id, op === "client" ? "CLIENT" : "INTERNAL");
    return { ok: true };
  });
}
