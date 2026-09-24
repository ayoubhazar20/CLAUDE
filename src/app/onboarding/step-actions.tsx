"use client";

import { useActionState } from "react";
import { onboardingStepAction } from "@/app/actions/organization";
import type { ActionState } from "@/lib/action-state";
import { saveCurrencyAction } from "./currency-action";
import { SubmitButton } from "@/components/forms";
import { Alert, Label, Select } from "@/components/ui";
import { CURRENCIES } from "@/domain/currencies";

export function StepActions({ step, optional }: { step: string; optional: boolean }) {
  const [state, action] = useActionState(onboardingStepAction, null);
  return (
    <form action={action} className="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
      <input type="hidden" name="step" value={step} />
      {state && !state.ok ? <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton name="status" value="done">{step === "ready" ? "Go to dashboard" : "Continue"}</SubmitButton>
      {optional ? <SubmitButton name="status" value="skipped" variant="secondary">Skip for now</SubmitButton> : null}
    </form>
  );
}

/** Currency step: updates only the default currency, keeping the rest of the profile. */
export function CurrencyForm({ current }: { current: string }) {
  const [state, action] = useActionState((_prev: ActionState, form: FormData) => saveCurrencyAction(form), null);
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-slate-600">New documents use this currency unless the deal or template specifies another. Changing a document’s currency never converts prices automatically.</p>
      <div className="max-w-xs">
        <Label htmlFor="currency">Default currency</Label>
        <Select id="currency" name="currency" defaultValue={current}>
          {Object.values(CURRENCIES).map((c) => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
        </Select>
      </div>
      {state ? state.ok ? <Alert tone="success">Currency saved.</Alert> : <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton variant="secondary">Save currency</SubmitButton>
    </form>
  );
}
