"use client";

import { ActionForm, FormResult, SubmitButton, TextField } from "@/components/forms";
import { updateNumberingAction } from "@/app/actions/organization";

export function NumberingForm(props: { type: string; prefix: string; includeYear: boolean; startNumber: number; padding: number }) {
  return (
    <ActionForm action={updateNumberingAction} className="grid gap-3 sm:grid-cols-2">
      {(state) => (
        <>
          <div className="sm:col-span-2"><FormResult state={state} /></div>
          <input type="hidden" name="documentType" value={props.type} />
          <TextField label="Prefix" name="prefix" defaultValue={props.prefix} state={state} />
          <TextField label="Starting number" name="startNumber" type="number" defaultValue={String(props.startNumber)} state={state} hint="(only moves forward)" />
          <TextField label="Number padding" name="padding" type="number" defaultValue={String(props.padding)} state={state} />
          <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" name="includeYear" defaultChecked={props.includeYear} /> Include year</label>
          <div className="sm:col-span-2"><SubmitButton variant="secondary">Save</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}
