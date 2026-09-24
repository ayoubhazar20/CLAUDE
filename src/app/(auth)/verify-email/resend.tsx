"use client";

import { ActionForm, FormResult, SubmitButton } from "@/components/forms";
import { resendVerificationAction } from "@/app/actions/auth";

export function ResendVerification() {
  return (
    <ActionForm action={resendVerificationAction} className="space-y-3" refreshOnSuccess={false}>
      {(state) => (
        <>
          <FormResult state={state} />
          <SubmitButton variant="secondary" pendingLabel="Sending…">Resend email</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
