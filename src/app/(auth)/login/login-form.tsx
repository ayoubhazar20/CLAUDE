"use client";

import { ActionForm, FormResult, SubmitButton, TextField } from "@/components/forms";
import { loginAction } from "@/app/actions/auth";

export function LoginForm({ next }: { next: string }) {
  return (
    <ActionForm action={loginAction} className="space-y-4" refreshOnSuccess={false}>
      {(state) => (
        <>
          <FormResult state={state} />
          <input type="hidden" name="next" value={next} />
          <TextField label="Email" name="email" type="email" autoComplete="email" required state={state} />
          <TextField label="Password" name="password" type="password" autoComplete="current-password" required state={state} />
          <SubmitButton className="w-full" pendingLabel="Signing in…">Sign in</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
