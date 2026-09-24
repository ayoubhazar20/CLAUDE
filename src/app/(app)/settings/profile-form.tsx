"use client";

import { ActionForm, FormResult, SubmitButton } from "@/components/forms";
import { CompanyFormFields, type CompanyDefaults } from "@/components/company-form-fields";
import { updateProfileAction } from "@/app/actions/organization";

export function ProfileForm({ defaults, onboardingStep }: { defaults: CompanyDefaults; onboardingStep?: string }) {
  return (
    <ActionForm action={updateProfileAction} className="space-y-5">
      {(state) => (
        <>
          <FormResult state={state} />
          {onboardingStep ? <input type="hidden" name="onboardingStep" value={onboardingStep} /> : null}
          <CompanyFormFields state={state} defaults={defaults} />
          <SubmitButton>Save profile</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
