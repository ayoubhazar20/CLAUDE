"use client";

import { ActionForm, FormResult, SubmitButton, TextField } from "@/components/forms";
import { registerAction } from "@/app/actions/auth";

export function RegisterForm() {
  return (
    <ActionForm action={registerAction} className="space-y-4" refreshOnSuccess={false}>
      {(state) => (
        <>
          <FormResult state={state} />
          <TextField label="Full name" name="name" autoComplete="name" required state={state} />
          <TextField label="Work email" name="email" type="email" autoComplete="email" required state={state} />
          <TextField label="Password" name="password" type="password" autoComplete="new-password" required state={state} hint="(10+ characters, mixed)" />
          <SubmitButton className="w-full" pendingLabel="Creating account…">Create account</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
