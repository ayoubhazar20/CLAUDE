"use client";

import type { ActionState } from "@/lib/action-state";
import { SelectField, TextField } from "./forms";
import { CURRENCIES } from "@/domain/currencies";

export interface CompanyDefaults {
  name?: string | null;
  legalName?: string | null;
  country?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  region?: string | null;
  phone?: string | null;
  website?: string | null;
  defaultCurrency?: string | null;
  timezone?: string | null;
  registrationNumber?: string | null;
  vatNumber?: string | null;
}

const TIMEZONES = [
  "Africa/Casablanca", "UTC", "Europe/London", "Europe/Paris", "Europe/Madrid", "Europe/Berlin", "America/New_York", "America/Chicago",
  "America/Denver", "America/Los_Angeles", "America/Toronto", "America/Vancouver", "Asia/Dubai", "Asia/Singapore", "Australia/Sydney",
];

export function CompanyFormFields({ state, defaults = {} }: { state: ActionState; defaults?: CompanyDefaults }) {
  const tz = defaults.timezone && !TIMEZONES.includes(defaults.timezone) ? [defaults.timezone, ...TIMEZONES] : TIMEZONES;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <TextField label="Company name" name="name" required state={state} defaultValue={defaults.name} />
      <TextField label="Legal company name" name="legalName" state={state} defaultValue={defaults.legalName} />
      <TextField label="Address" name="addressLine1" required state={state} defaultValue={defaults.addressLine1} />
      <TextField label="Address line 2" name="addressLine2" state={state} defaultValue={defaults.addressLine2} />
      <TextField label="City" name="city" state={state} defaultValue={defaults.city} />
      <TextField label="Postal code" name="postalCode" state={state} defaultValue={defaults.postalCode} />
      <TextField label="Region / State" name="region" state={state} defaultValue={defaults.region} />
      <TextField label="Country" name="country" required state={state} defaultValue={defaults.country} />
      <TextField label="Phone" name="phone" state={state} defaultValue={defaults.phone} />
      <TextField label="Website" name="website" state={state} defaultValue={defaults.website} />
      <SelectField label="Default currency" name="defaultCurrency" state={state} defaultValue={defaults.defaultCurrency ?? "MAD"} options={Object.values(CURRENCIES).map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))} />
      <SelectField label="Timezone" name="timezone" state={state} defaultValue={defaults.timezone ?? "Africa/Casablanca"} options={tz.map((t) => ({ value: t, label: t }))} />
      <SelectField label="Language" name="language" state={state} defaultValue="en" options={[{ value: "en", label: "English" }]} />
      <div />
      <TextField label="Registration number" name="registrationNumber" state={state} defaultValue={defaults.registrationNumber} hint="(if applicable)" />
      <TextField label="VAT number" name="vatNumber" state={state} defaultValue={defaults.vatNumber} hint="(if applicable)" />
    </div>
  );
}
