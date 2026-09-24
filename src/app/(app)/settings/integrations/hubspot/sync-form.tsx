"use client";

import { ActionForm, FormResult, SubmitButton } from "@/components/forms";
import { hubspotAction } from "@/app/actions/settings";

export function SyncSettingsForm({ writebackEnabled, pipelineAutomationEnabled }: { writebackEnabled: boolean; pipelineAutomationEnabled: boolean }) {
  return (
    <ActionForm action={hubspotAction} className="space-y-3">
      {(state) => (
        <>
          <FormResult state={state} />
          <input type="hidden" name="op" value="settings" />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="writebackEnabled" defaultChecked={writebackEnabled} className="mt-1" />
            <span><span className="font-medium">Write document information back to deals</span><br /><span className="text-slate-500">Latest quote/contract number, status, URL, amount and dates (see Property mapping).</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="pipelineAutomationEnabled" defaultChecked={pipelineAutomationEnabled} className="mt-1" />
            <span><span className="font-medium">Move deals through the pipeline</span><br /><span className="text-slate-500">Based on your Pipeline automation rules.</span></span>
          </label>
          <SubmitButton>Save</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
