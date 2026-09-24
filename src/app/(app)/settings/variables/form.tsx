"use client";

import { ActionForm, FormResult, SelectField, SubmitButton, TextField } from "@/components/forms";
import { customFieldAction } from "@/app/actions/settings";

export function CustomFieldForm() {
  return (
    <ActionForm action={customFieldAction} className="grid gap-3 sm:grid-cols-2" resetOnSuccess>
      {(state) => (
        <>
          <div className="sm:col-span-2"><FormResult state={state} /></div>
          <TextField label="Variable key" name="key" required state={state} placeholder="payment.terms" hint="(letters, dots)" />
          <TextField label="Label" name="label" required state={state} placeholder="Payment terms" />
          <SelectField label="Type" name="type" state={state} defaultValue="TEXT" options={[{ value: "TEXT", label: "Text" }, { value: "LONG_TEXT", label: "Long text" }, { value: "NUMBER", label: "Number" }, { value: "DATE", label: "Date" }, { value: "BOOLEAN", label: "Yes / No" }, { value: "SELECT", label: "Choice list" }]} />
          <TextField label="Options" name="options" state={state} hint="(choice list, comma separated)" />
          <TextField label="Default value" name="defaultValue" state={state} />
          <fieldset className="flex items-end gap-4 text-sm">
            <legend className="mb-1 text-sm font-medium text-slate-700">Applies to</legend>
            <label className="flex items-center gap-1"><input type="checkbox" name="appliesTo" value="QUOTE" defaultChecked /> Quotes</label>
            <label className="flex items-center gap-1"><input type="checkbox" name="appliesTo" value="CONTRACT" defaultChecked /> Contracts</label>
            <label className="flex items-center gap-1"><input type="checkbox" name="required" /> Required</label>
          </fieldset>
          <div className="sm:col-span-2"><SubmitButton>Add variable</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}
