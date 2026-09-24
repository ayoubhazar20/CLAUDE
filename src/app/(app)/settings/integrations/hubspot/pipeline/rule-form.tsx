"use client";

import { ActionForm, FormResult, SubmitButton } from "@/components/forms";
import { Label, Select } from "@/components/ui";
import { hubspotAction } from "@/app/actions/settings";

export function PipelineRuleForm({ events, pipelines }: { events: { value: string; label: string }[]; pipelines: { id: string; label: string; stages: { id: string; label: string }[] }[] }) {
  return (
    <ActionForm action={hubspotAction} className="grid gap-3 sm:grid-cols-3 sm:items-end">
      {(state) => (
        <>
          <div className="sm:col-span-3"><FormResult state={state} /></div>
          <input type="hidden" name="op" value="pipeline" />
          <div>
            <Label htmlFor="pl-event">DealDocs event</Label>
            <Select id="pl-event" name="event">{events.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</Select>
          </div>
          <div>
            <Label htmlFor="pl-stage">Pipeline → stage</Label>
            <Select id="pl-stage" name="stage" required>
              {pipelines.map((p) => (
                <optgroup key={p.id} label={p.label}>
                  {p.stages.map((s) => <option key={s.id} value={`${p.id}::${s.id}`}>{s.label}</option>)}
                </optgroup>
              ))}
            </Select>
          </div>
          <SubmitButton>Save rule</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
