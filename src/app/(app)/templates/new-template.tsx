"use client";

import { ActionForm, FormResult, SelectField, SubmitButton, TextField } from "@/components/forms";
import { createTemplateAction } from "@/app/actions/templates";

export function NewTemplateForm({ defaultType }: { defaultType: "QUOTE" | "CONTRACT" }) {
  return (
    <ActionForm action={createTemplateAction} className="space-y-3" refreshOnSuccess={false}>
      {(state) => (
        <>
          <FormResult state={state} />
          <TextField label="Name" name="name" required state={state} placeholder="e.g. Consulting quote" />
          <SelectField label="Type" name="documentType" state={state} defaultValue={defaultType} options={[{ value: "QUOTE", label: "Quote" }, { value: "CONTRACT", label: "Contract" }]} />
          <TextField label="Description" name="description" state={state} hint="(optional)" />
          <SubmitButton>Create & open builder</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
