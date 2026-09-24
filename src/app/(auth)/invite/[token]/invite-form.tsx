"use client";

import { ActionForm, FormResult, SubmitButton, TextField } from "@/components/forms";
import { acceptInvitationAction } from "@/app/actions/auth";

export function InviteForm({ token, needsAccount }: { token: string; needsAccount: boolean }) {
  return (
    <ActionForm action={acceptInvitationAction} className="space-y-4" refreshOnSuccess={false}>
      {(state) => (
        <>
          <FormResult state={state} />
          <input type="hidden" name="token" value={token} />
          {needsAccount ? (
            <>
              <TextField label="Full name" name="name" autoComplete="name" required state={state} />
              <TextField label="Password" name="password" type="password" autoComplete="new-password" required state={state} />
            </>
          ) : null}
          <SubmitButton className="w-full">Accept invitation</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
