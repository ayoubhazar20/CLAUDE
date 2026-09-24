"use client";

import Link from "next/link";
import { ActionForm, FormResult, SubmitButton, TextField } from "@/components/forms";
import { forgotPasswordAction } from "@/app/actions/auth";

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Reset your password</h1>
      <p className="mb-6 text-sm text-slate-600">Enter your email and we will send you a reset link.</p>
      <ActionForm action={forgotPasswordAction} className="space-y-4" refreshOnSuccess={false}>
        {(state) => (
          <>
            <FormResult state={state} />
            <TextField label="Email" name="email" type="email" autoComplete="email" required state={state} />
            <SubmitButton className="w-full" pendingLabel="Sending…">Send reset link</SubmitButton>
          </>
        )}
      </ActionForm>
      <p className="mt-6 text-center text-sm"><Link href="/login" className="text-brand-700 hover:underline">Back to sign in</Link></p>
    </>
  );
}
