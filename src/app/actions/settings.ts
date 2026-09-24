"use server";

import { z } from "zod";
import { formBool, formString, runAction } from "@/server/actions";
import { requireOrgApi } from "@/server/auth/context";
import { archiveTeam, changeMemberRole, createTeam, inviteUser, revokeInvitation, setMembershipStatus, setTeamMember } from "@/server/services/members";
import { saveEmailTemplate } from "@/server/services/email-templates";
import { archiveCustomField, upsertCustomField } from "@/server/services/custom-fields";
import { disconnectHubSpot } from "@/server/hubspot/oauth";
import {
  deletePipelineMapping,
  deletePropertyMapping,
  installWritebackProperties,
  updateConnectionSettings,
  upsertPipelineMapping,
  upsertPropertyMapping,
} from "@/server/hubspot/settings";
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

export async function hubspotAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("hubspot", async () => {
    const ctx = await requireOrgApi();
    switch (formString(form, "op")) {
      case "disconnect":
        await disconnectHubSpot(ctx, formString(form, "connectionId"));
        return { ok: true, message: "HubSpot disconnected." };
      case "settings":
        await updateConnectionSettings(ctx, { writebackEnabled: formBool(form, "writebackEnabled"), pipelineAutomationEnabled: formBool(form, "pipelineAutomationEnabled"), defaultDocumentType: (formString(form, "defaultDocumentType") || "QUOTE") as "QUOTE" });
        return { ok: true, message: "Synchronization settings saved." };
      case "mapping":
        await upsertPropertyMapping(ctx, {
          objectType: formString(form, "objectType") as "DEAL",
          hubspotProperty: formString(form, "hubspotProperty"),
          variableKey: formString(form, "variableKey"),
          direction: formString(form, "direction") as "IMPORT",
          label: formString(form, "label") || null,
        });
        return { ok: true, message: "Mapping saved." };
      case "deleteMapping":
        await deletePropertyMapping(ctx, formString(form, "id"));
        return { ok: true, message: "Mapping removed." };
      case "installWriteback":
        await installWritebackProperties(ctx);
        return { ok: true, message: "DealDocs properties created in HubSpot and mapped." };
      case "pipeline": {
        const [pipelineId, stageId] = formString(form, "stage").split("::");
        await upsertPipelineMapping(ctx, { event: formString(form, "event") as "QUOTE_PUBLISHED", pipelineId: pipelineId ?? "", stageId: stageId ?? "" });
        return { ok: true, message: "Pipeline automation saved." };
      }
      case "deletePipeline":
        await deletePipelineMapping(ctx, formString(form, "id"));
        return { ok: true, message: "Automation removed." };
      default:
        return { ok: false, error: "Unknown operation" };
    }
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
