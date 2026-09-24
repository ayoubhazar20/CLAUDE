"use client";

import { ActionForm, FormResult, SelectField, SubmitButton, TextField } from "@/components/forms";
import { teamAction } from "@/app/actions/settings";

export function CreateTeamForm() {
  return (
    <ActionForm action={teamAction} className="flex flex-col gap-3 sm:flex-row sm:items-end" resetOnSuccess>
      {(state) => (
        <>
          <input type="hidden" name="op" value="create" />
          <div className="flex-1"><TextField label="Team name" name="name" required state={state} /></div>
          <SubmitButton>Create team</SubmitButton>
          <FormResult state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function TeamMemberForm({ teamId, members }: { teamId: string; members: { id: string; name: string }[] }) {
  if (!members.length) return null;
  return (
    <ActionForm action={teamAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      {(state) => (
        <>
          <input type="hidden" name="op" value="member" />
          <input type="hidden" name="teamId" value={teamId} />
          <div className="flex-1"><SelectField label="Add member" name="membershipId" state={state} options={members.map((m) => ({ value: m.id, label: m.name }))} /></div>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="isManager" /> Manager</label>
          <SubmitButton variant="secondary">Add</SubmitButton>
          <FormResult state={state} />
        </>
      )}
    </ActionForm>
  );
}
