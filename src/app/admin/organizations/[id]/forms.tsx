"use client";

import type { OrganizationStatus } from "@prisma/client";
import { ActionForm, FormResult, SelectField, SubmitButton, TextField } from "@/components/forms";
import { assignPlanAction, orgLifecycleAction } from "@/app/actions/admin";

export function LifecycleForms({ organizationId, status }: { organizationId: string; status: OrganizationStatus }) {
  return (
    <ActionForm action={orgLifecycleAction} className="space-y-3">
      {(state) => (
        <>
          <FormResult state={state} />
          <input type="hidden" name="organizationId" value={organizationId} />
          {status === "PENDING_APPROVAL" || status === "SUSPENDED" || status === "ACTIVE" ? <TextField label="Reason (for reject / suspend)" name="reason" state={state} /> : null}
          <div className="flex flex-wrap gap-2">
            {status === "PENDING_APPROVAL" || status === "REJECTED" ? <SubmitButton name="op" value="approve">Approve</SubmitButton> : null}
            {status === "PENDING_APPROVAL" ? <SubmitButton name="op" value="reject" variant="danger">Reject</SubmitButton> : null}
            {status === "ACTIVE" ? <SubmitButton name="op" value="suspend" variant="danger">Suspend</SubmitButton> : null}
            {status === "SUSPENDED" ? <SubmitButton name="op" value="reactivate">Reactivate</SubmitButton> : null}
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function PlanForm({ organizationId, plans, current }: { organizationId: string; plans: { id: string; name: string }[]; current: string | null }) {
  return (
    <ActionForm action={assignPlanAction} className="space-y-2">
      {(state) => (
        <>
          <FormResult state={state} />
          <input type="hidden" name="organizationId" value={organizationId} />
          <SelectField label="Assign plan" name="planId" state={state} defaultValue={current ?? plans[0]?.id} options={plans.map((p) => ({ value: p.id, label: p.name }))} />
          <SubmitButton variant="secondary">Assign</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
