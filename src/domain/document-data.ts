import { z } from "zod";

/**
 * Document-specific data snapshot. Once imported from HubSpot this data belongs to
 * the document: editing it never writes back to the original HubSpot records.
 */
const str = (max = 500) => z.string().max(max).default("");

export const contactSchema = z.object({
  hubspotId: z.string().max(64).nullable().default(null),
  firstName: str(),
  lastName: str(),
  email: str(320),
  phone: str(64),
  jobTitle: str(),
});

export const companySchema = z.object({
  hubspotId: z.string().max(64).nullable().default(null),
  name: str(),
  address: str(),
  city: str(),
  zip: str(64),
  country: str(),
  phone: str(64),
  domain: str(),
});

export const dealSchema = z.object({
  hubspotId: z.string().max(64).nullable().default(null),
  name: str(),
  amount: str(64),
  pipeline: str(),
  pipelineId: str(128),
  stage: str(),
  stageId: str(128),
  closeDate: str(64),
  owner: z
    .object({ hubspotId: z.string().max(64).nullable().default(null), name: str(), email: str(320) })
    .default({}),
});

export const recipientSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  role: z.enum(["SIGNER", "APPROVER", "CC"]).default("SIGNER"),
  signingOrder: z.number().int().min(1).max(20).default(1),
  required: z.boolean().default(true),
  hubspotContactId: z.string().max(64).nullable().default(null),
});

export type RecipientData = z.infer<typeof recipientSchema>;

export const documentDataSchema = z.object({
  contact: contactSchema.default({}),
  company: companySchema.default({}),
  deal: dealSchema.default({}),
  /** Values of mapped HubSpot properties keyed by DealDocs variable key. */
  hubspotProperties: z.record(z.string().max(5000)).default({}),
  /** Snapshot of custom field values at publication (keyed by variable key). */
  customFields: z.record(z.string().max(5000)).default({}),
  /**
   * Recipients / signatories. Edited on the draft version and materialised into
   * DocumentRecipient rows when the version is published.
   */
  recipients: z.array(recipientSchema).max(20).default([]),
  /** Sender (document owner) at publication time. */
  sender: z.object({ name: str(), email: str(320) }).default({}),
});

export type DocumentData = z.infer<typeof documentDataSchema>;
export type ContactData = z.infer<typeof contactSchema>;
export type CompanyData = z.infer<typeof companySchema>;
export type DealData = z.infer<typeof dealSchema>;

export function parseDocumentData(input: unknown): DocumentData {
  return documentDataSchema.parse(input ?? {});
}

export function emptyDocumentData(): DocumentData {
  return documentDataSchema.parse({});
}
