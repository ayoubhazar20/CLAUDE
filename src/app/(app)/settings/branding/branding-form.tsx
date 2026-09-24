"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, FormResult, SubmitButton } from "@/components/forms";
import { Alert, Input, Label } from "@/components/ui";
import { updateBrandingAction } from "@/app/actions/organization";

export function BrandingForm({ brandColor, logoFileId, onboarding }: { brandColor: string; logoFileId: string | null; onboarding?: boolean }) {
  const router = useRouter();
  const [color, setColor] = useState(brandColor);
  const [logo, setLogo] = useState(logoFileId);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  return (
    <div className="space-y-6">
      <div>
        <Label htmlFor="logo">Company logo</Label>
        <div className="flex items-center gap-4">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/files/${logo}`} alt="Company logo" className="h-14 max-w-[200px] rounded border border-slate-200 object-contain p-1" />
          ) : (
            <div className="flex h-14 w-32 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-400">No logo</div>
          )}
          <input
            id="logo"
            type="file"
            accept="image/png,image/jpeg"
            className="text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setUploading(true);
              setError(null);
              const body = new FormData();
              body.set("file", file);
              const res = await fetch("/api/uploads/logo", { method: "POST", body });
              const json = await res.json().catch(() => null);
              setUploading(false);
              if (!res.ok) setError(json?.error?.message ?? "Upload failed");
              else {
                setLogo(json.fileId);
                router.refresh();
              }
            }}
          />
        </div>
        <p className="mt-1 text-xs text-slate-500">PNG or JPEG, max 2 MB.{uploading ? " Uploading…" : ""}</p>
        {error ? <div className="mt-2"><Alert tone="error">{error}</Alert></div> : null}
      </div>
      <ActionForm action={updateBrandingAction} className="space-y-4">
        {(state) => (
          <>
            <FormResult state={state} />
            {onboarding ? <input type="hidden" name="onboardingStep" value="branding" /> : null}
            <div>
              <Label htmlFor="brandColor">Brand color</Label>
              <div className="flex items-center gap-2">
                <input type="color" aria-label="Pick brand color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-14 cursor-pointer rounded border border-slate-300" />
                <Input id="brandColor" name="brandColor" value={color} onChange={(e) => setColor(e.target.value)} className="w-32 font-mono" />
              </div>
            </div>
            <SubmitButton>Save branding</SubmitButton>
          </>
        )}
      </ActionForm>
    </div>
  );
}
