"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, FormResult, SelectField, SubmitButton, TextField } from "@/components/forms";
import { Select } from "@/components/ui";
import { inviteAction, memberAction } from "@/app/actions/settings";

export function InviteForm({ roles, teams }: { roles: { id: string; name: string }[]; teams: { id: string; name: string }[] }) {
  const userRole = roles.find((r) => r.name === "User") ?? roles[0];
  return (
    <ActionForm action={inviteAction} className="grid gap-3 sm:grid-cols-4 sm:items-end" resetOnSuccess>
      {(state) => (
        <>
          <div className="sm:col-span-4"><FormResult state={state} /></div>
          <TextField label="Email" name="email" type="email" required state={state} />
          <SelectField label="Role" name="roleId" state={state} defaultValue={userRole?.id} options={roles.map((r) => ({ value: r.id, label: r.name }))} />
          <SelectField label="Team" name="teamId" state={state} defaultValue="" options={[{ value: "", label: "No team" }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} />
          <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function RoleSelect({ membershipId, roleId, roles }: { membershipId: string; roleId: string; roles: { id: string; name: string }[] }) {
  const [state, action] = useActionState(memberAction, null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={action}>
      <input type="hidden" name="op" value="role" />
      <input type="hidden" name="membershipId" value={membershipId} />
      <Select name="roleId" defaultValue={roleId} aria-label="Role" className="py-1 text-sm" onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </Select>
      {state && !state.ok ? <p className="mt-1 text-xs text-red-600">{state.error}</p> : null}
    </form>
  );
}
