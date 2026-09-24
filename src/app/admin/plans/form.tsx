"use client";

import { ActionForm, FormResult, SubmitButton, TextField } from "@/components/forms";
import { updatePlanAction } from "@/app/actions/admin";

export function PlanEditForm({ plan }: { plan: { id: string; name: string; maxUsers: number | null; maxDocumentsPerMonth: number | null; maxStorageMb: number | null; isActive: boolean } }) {
  return (
    <ActionForm action={updatePlanAction} className="grid gap-3 sm:grid-cols-2">
      {(state) => (
        <>
          <div className="sm:col-span-2"><FormResult state={state} /></div>
          <input type="hidden" name="id" value={plan.id} />
          <TextField label="Name" name="name" defaultValue={plan.name} state={state} />
          <TextField label="Max users" name="maxUsers" type="number" defaultValue={plan.maxUsers?.toString() ?? ""} state={state} />
          <TextField label="Documents / month" name="maxDocumentsPerMonth" type="number" defaultValue={plan.maxDocumentsPerMonth?.toString() ?? ""} state={state} />
          <TextField label="Storage (MB)" name="maxStorageMb" type="number" defaultValue={plan.maxStorageMb?.toString() ?? ""} state={state} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isActive" defaultChecked={plan.isActive} /> Active</label>
          <div className="sm:col-span-2"><SubmitButton variant="secondary">Save</SubmitButton></div>
        </>
      )}
    </ActionForm>
  );
}
