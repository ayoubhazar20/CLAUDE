"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Alert, Button, Field, Input, Select, Textarea } from "./ui";
import type { ActionState } from "@/lib/action-state";

export function SubmitButton({ children, variant = "primary", pendingLabel, className, name, value }: { children: ReactNode; variant?: "primary" | "secondary" | "danger"; pendingLabel?: string; className?: string; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} disabled={pending} aria-busy={pending} className={className} name={name} value={value}>
      {pending ? pendingLabel ?? "Working…" : children}
    </Button>
  );
}

export function FormResult({ state }: { state: ActionState }) {
  if (!state) return null;
  if (state.ok) return state.message ? <Alert tone="success">{state.message}</Alert> : null;
  return <Alert tone="error">{state.error}</Alert>;
}

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/** Form bound to a server action with inline success/error feedback. */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  refreshOnSuccess = true,
  onSuccess,
}: {
  action: Action;
  children: (state: ActionState) => ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  refreshOnSuccess?: boolean;
  onSuccess?: () => void;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) ref.current?.reset();
      if (refreshOnSuccess) router.refresh();
      onSuccess?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form ref={ref} action={formAction} className={className} noValidate>
      {children(state)}
    </form>
  );
}

export function fieldError(state: ActionState, name: string): string[] | undefined {
  return state && !state.ok ? state.fieldErrors?.[name] : undefined;
}

export function TextField(props: { label: string; name: string; state: ActionState; type?: string; defaultValue?: string | null; required?: boolean; autoComplete?: string; placeholder?: string; hint?: string; maxLength?: number }) {
  const err = fieldError(props.state, props.name);
  return (
    <Field label={props.label} name={props.name} error={err} hint={props.hint}>
      <Input
        id={props.name}
        name={props.name}
        type={props.type ?? "text"}
        defaultValue={props.defaultValue ?? undefined}
        required={props.required}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        aria-invalid={err ? true : undefined}
        aria-describedby={err ? `${props.name}-error` : undefined}
      />
    </Field>
  );
}

export function TextAreaField(props: { label: string; name: string; state: ActionState; defaultValue?: string | null; rows?: number; hint?: string }) {
  const err = fieldError(props.state, props.name);
  return (
    <Field label={props.label} name={props.name} error={err} hint={props.hint}>
      <Textarea id={props.name} name={props.name} rows={props.rows ?? 4} defaultValue={props.defaultValue ?? undefined} aria-invalid={err ? true : undefined} />
    </Field>
  );
}

export function SelectField(props: { label: string; name: string; state: ActionState; options: { value: string; label: string }[]; defaultValue?: string | null; hint?: string }) {
  const err = fieldError(props.state, props.name);
  return (
    <Field label={props.label} name={props.name} error={err} hint={props.hint}>
      <Select id={props.name} name={props.name} defaultValue={props.defaultValue ?? undefined}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Small inline form for one-click server actions (archive, approve…) with optional confirmation. */
export function InlineAction({ action, children, confirm, variant = "secondary", hidden }: { action: Action; children: ReactNode; confirm?: string; variant?: "primary" | "secondary" | "danger"; hidden?: Record<string, string> }) {
  const [state, formAction] = useActionState(action, null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="inline"
    >
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <SubmitButton variant={variant}>{children}</SubmitButton>
      {state && !state.ok ? <span className="ml-2 text-sm text-red-600" role="alert">{state.error}</span> : null}
    </form>
  );
}
