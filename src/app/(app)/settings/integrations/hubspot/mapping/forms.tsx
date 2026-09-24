"use client";

import { useState } from "react";
import { ActionForm, FormResult, SubmitButton } from "@/components/forms";
import { Input, Label, Select } from "@/components/ui";
import { hubspotAction } from "@/app/actions/settings";

type Prop = { name: string; label: string; custom: boolean };

export function ImportMappingForm({ properties }: { properties: Record<"DEAL" | "CONTACT" | "COMPANY", Prop[] | null> }) {
  const [objectType, setObjectType] = useState<"DEAL" | "CONTACT" | "COMPANY">("DEAL");
  const [property, setProperty] = useState("");
  const [variable, setVariable] = useState("");
  const list = properties[objectType];
  const suggest = (name: string) => {
    const camel = name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const prefix = objectType === "DEAL" ? "deal" : objectType === "CONTACT" ? "contact" : "company";
    return `${prefix}.${camel}`;
  };
  return (
    <ActionForm action={hubspotAction} className="grid gap-3 sm:grid-cols-4 sm:items-end" resetOnSuccess>
      {(state) => (
        <>
          <div className="sm:col-span-4"><FormResult state={state} /></div>
          <input type="hidden" name="op" value="mapping" />
          <input type="hidden" name="direction" value="IMPORT" />
          <div>
            <Label htmlFor="map-object">HubSpot object</Label>
            <Select id="map-object" name="objectType" value={objectType} onChange={(e) => { setObjectType(e.target.value as "DEAL"); setProperty(""); }}>
              <option value="DEAL">Deal</option>
              <option value="CONTACT">Contact</option>
              <option value="COMPANY">Company</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="map-prop">HubSpot property</Label>
            {list ? (
              <Select id="map-prop" name="hubspotProperty" value={property} onChange={(e) => { setProperty(e.target.value); if (!variable) setVariable(suggest(e.target.value)); }} required>
                <option value="">Select…</option>
                <optgroup label="Custom properties">{list.filter((p) => p.custom).map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}</optgroup>
                <optgroup label="Standard properties">{list.filter((p) => !p.custom).map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}</optgroup>
              </Select>
            ) : (
              <Input id="map-prop" name="hubspotProperty" value={property} onChange={(e) => setProperty(e.target.value)} placeholder="internal_name" required />
            )}
          </div>
          <div>
            <Label htmlFor="map-var">DealDocs variable</Label>
            <Input id="map-var" name="variableKey" value={variable} onChange={(e) => setVariable(e.target.value)} placeholder="project.startDate" required />
          </div>
          <SubmitButton>Add mapping</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function WritebackMappingForm({ sources, dealProperties }: { sources: { key: string; label: string }[]; dealProperties: Prop[] | null }) {
  return (
    <ActionForm action={hubspotAction} className="grid gap-3 sm:grid-cols-3 sm:items-end" resetOnSuccess>
      {(state) => (
        <>
          <div className="sm:col-span-3"><FormResult state={state} /></div>
          <input type="hidden" name="op" value="mapping" />
          <input type="hidden" name="direction" value="WRITEBACK" />
          <input type="hidden" name="objectType" value="DEAL" />
          <div>
            <Label htmlFor="wb-source">DealDocs value</Label>
            <Select id="wb-source" name="variableKey" required>
              {sources.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="wb-prop">HubSpot deal property</Label>
            {dealProperties ? (
              <Select id="wb-prop" name="hubspotProperty" required>
                <option value="">Select…</option>
                {dealProperties.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
              </Select>
            ) : (
              <Input id="wb-prop" name="hubspotProperty" placeholder="internal_name" required />
            )}
          </div>
          <SubmitButton variant="secondary">Add writeback</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
