"use client";

import { ActionForm, FormResult, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { emailTemplateAction } from "@/app/actions/settings";

export function EmailTemplateForm({ kind, subject, body }: { kind: string; subject: string; body: string }) {
  return (
    <ActionForm action={emailTemplateAction} className="space-y-3">
      {(state) => (
        <>
          <FormResult state={state} />
          <input type="hidden" name="kind" value={kind} />
          <TextField label="Subject" name="subject" defaultValue={subject} required state={state} />
          <TextAreaField label="Message" name="body" defaultValue={body} rows={8} state={state} />
          <SubmitButton variant="secondary">Save</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
