"use server";

import { z } from "zod";
import { formBool, formString, runAction } from "@/server/actions";
import { requireOrgApi } from "@/server/auth/context";
import { archiveTeam, changeMemberRole, createTeam, inviteUser, revokeInvitation, setMembershipStatus, setTeamMember } from "@/server/services/members";
import { saveEmailTemplate } from "@/server/services/email-templates";
import { archiveCustomField, upsertCustomField } from "@/server/services/custom-fields";
import { markNotificationsRead } from "@/server/services/notifications";
import type { ActionState } from "@/lib/action-state";

export async function inviteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("invite", async () => {
    const ctx = await requireOrgApi();
    await inviteUser(ctx, { email: formString(form, "email"), roleId: formString(form, "roleId"), teamId: formString(form, "teamId") || null });
    return { ok: true, message: "Invitation sent." };
  });
}

export async function memberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("member", async () => {
    const ctx = await requireOrgApi();
    const op = formString(form, "op");
    if (op === "revokeInvite") {
      await revokeInvitation(ctx, formString(form, "invitationId"));
      return { ok: true, message: "Invitation revoked." };
    }
    const membershipId = z.string().uuid().parse(formString(form, "membershipId"));
    if (op === "disable") await setMembershipStatus(ctx, membershipId, false);
    else if (op === "enable") await setMembershipStatus(ctx, membershipId, true);
    else if (op === "role") await changeMemberRole(ctx, membershipId, formString(form, "roleId"));
    else return { ok: false, error: "Unknown operation" };
    return { ok: true, message: "User updated." };
  });
}

export async function teamAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("team", async () => {
    const ctx = await requireOrgApi();
    const op = formString(form, "op");
    if (op === "create") await createTeam(ctx, formString(form, "name"));
    else if (op === "archive") await archiveTeam(ctx, formString(form, "teamId"));
    else if (op === "member") await setTeamMember(ctx, formString(form, "teamId"), formString(form, "membershipId"), formString(form, "member") !== "0", formBool(form, "isManager"));
    else return { ok: false, error: "Unknown operation" };
    return { ok: true, message: "Teams updated." };
  });
}

export async function emailTemplateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("emailTemplate", async () => {
    const ctx = await requireOrgApi();
    await saveEmailTemplate(ctx, { kind: formString(form, "kind") as "QUOTE_SEND", subject: formString(form, "subject"), body: formString(form, "body") });
    return { ok: true, message: "Email template saved." };
  });
}

export async function customFieldAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("customField", async () => {
    const ctx = await requireOrgApi();
    if (formString(form, "op") === "archive") {
      await archiveCustomField(ctx, formString(form, "id"));
      return { ok: true, message: "Variable archived." };
    }
    const appliesTo = form.getAll("appliesTo").map(String) as ("QUOTE" | "CONTRACT")[];
    await upsertCustomField(
      ctx,
      {
        key: formString(form, "key"),
        label: formString(form, "label"),
        type: formString(form, "type") as "TEXT",
        options: formString(form, "options").split(",").map((o) => o.trim()).filter(Boolean),
        defaultValue: formString(form, "defaultValue") || null,
        appliesTo: appliesTo.length ? appliesTo : ["QUOTE", "CONTRACT"],
        required: formBool(form, "required"),
      },
      formString(form, "id") || undefined,
    );
    return { ok: true, message: "Variable saved." };
  });
}

export async function markReadAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("markRead", async () => {
    const ctx = await requireOrgApi();
    const id = formString(form, "id");
    await markNotificationsRead(ctx.organizationId, ctx.user.id, id ? [id] : undefined);
    return { ok: true };
  });
}
