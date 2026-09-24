"use client";

import Link from "next/link";
import { ActionForm, FormResult, SubmitButton, fieldError } from "@/components/forms";
import { CompanyFormFields } from "@/components/company-form-fields";
import { createCompanyAction } from "@/app/actions/organization";

export function CompanyForm({ termsVersion, privacyVersion }: { termsVersion: string; privacyVersion: string }) {
  return (
    <ActionForm action={createCompanyAction} className="space-y-5" refreshOnSuccess={false}>
      {(state) => (
        <>
          <FormResult state={state} />
          <CompanyFormFields state={state} />
          <fieldset className="space-y-2 border-t border-slate-100 pt-4">
            <legend className="sr-only">Legal agreements</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acceptTerms" className="mt-0.5" required />
              <span>
                I accept the <Link href="/legal/terms" target="_blank" className="text-brand-700 underline">Terms of Service</Link> (version {termsVersion}).
              </span>
            </label>
            {fieldError(state, "acceptTerms") ? <p className="text-sm text-red-600">{fieldError(state, "acceptTerms")![0]}</p> : null}
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acceptPrivacy" className="mt-0.5" required />
              <span>
                I accept the <Link href="/legal/privacy" target="_blank" className="text-brand-700 underline">Privacy Policy</Link> (version {privacyVersion}).
              </span>
            </label>
            {fieldError(state, "acceptPrivacy") ? <p className="text-sm text-red-600">{fieldError(state, "acceptPrivacy")![0]}</p> : null}
          </fieldset>
          <SubmitButton pendingLabel="Submitting…">Submit for approval</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
