"use client";

import { ActionForm, FormResult, SubmitButton, TextField } from "@/components/forms";
import { resetPasswordAction } from "@/app/actions/auth";

export function ResetForm({ token }: { token: string }) {
  return (
    <ActionForm action={resetPasswordAction} className="space-y-4" refreshOnSuccess={false}>
      {(state) => (
        <>
          <FormResult state={state} />
          <input type="hidden" name="token" value={token} />
          <TextField label="New password" name="password" type="password" autoComplete="new-password" required state={state} />
          <TextField label="Confirm password" name="confirm" type="password" autoComplete="new-password" required state={state} />
          <SubmitButton className="w-full">Update password</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
