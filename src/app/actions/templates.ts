"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { formString, runAction } from "@/server/actions";
import { requireOrgApi } from "@/server/auth/context";
import { createTemplate, duplicateTemplate, publishTemplate, setDefaultTemplate, setTemplateArchived } from "@/server/services/templates";
import type { ActionState } from "@/lib/action-state";

export async function createTemplateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let id = "";
  const result = await runAction("createTemplate", async () => {
    const ctx = await requireOrgApi();
    id = (await createTemplate(ctx, { name: formString(form, "name"), documentType: formString(form, "documentType") as "QUOTE" | "CONTRACT", description: formString(form, "description") })).id;
  });
  if (!result?.ok) return result;
  redirect(`/templates/${id}`);
}

const tid = (form: FormData) => z.string().uuid().parse(formString(form, "templateId"));

export async function templateOpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  let redirectTo: string | null = null;
  const result = await runAction("templateOp", async () => {
    const ctx = await requireOrgApi();
    const id = tid(form);
    switch (formString(form, "op")) {
      case "publish":
        await publishTemplate(ctx, id);
        return { ok: true, message: "Template published. New documents will use this version." };
      case "duplicate":
        redirectTo = `/templates/${(await duplicateTemplate(ctx, id)).id}`;
        return;
      case "archive":
        await setTemplateArchived(ctx, id, true);
        return { ok: true, message: "Template archived." };
      case "restore":
        await setTemplateArchived(ctx, id, false);
        return { ok: true, message: "Template restored." };
      case "default":
        await setDefaultTemplate(ctx, id);
        return { ok: true, message: "Default template updated." };
      default:
        return { ok: false, error: "Unknown operation" };
    }
  });
  if (redirectTo && result?.ok) redirect(redirectTo);
  return result;
}
