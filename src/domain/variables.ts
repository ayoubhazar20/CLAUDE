/**
 * Dynamic variables: {{contact.firstName}}, {{document.total}} …
 * The catalog feeds the variable picker so users never need to type variables.
 */

export interface VariableDefinition {
  key: string;
  label: string;
  group: string;
}

export const VARIABLE_GROUPS = ["Contact", "Company", "Deal", "Document", "Sender", "Custom", "HubSpot"] as const;

export const BUILTIN_VARIABLES: VariableDefinition[] = [
  { key: "contact.firstName", label: "First name", group: "Contact" },
  { key: "contact.lastName", label: "Last name", group: "Contact" },
  { key: "contact.fullName", label: "Full name", group: "Contact" },
  { key: "contact.email", label: "Email", group: "Contact" },
  { key: "contact.phone", label: "Phone", group: "Contact" },
  { key: "contact.jobTitle", label: "Job title", group: "Contact" },
  { key: "company.name", label: "Name", group: "Company" },
  { key: "company.address", label: "Address", group: "Company" },
  { key: "company.city", label: "City", group: "Company" },
  { key: "company.zip", label: "Postal code", group: "Company" },
  { key: "company.country", label: "Country", group: "Company" },
  { key: "company.phone", label: "Phone", group: "Company" },
  { key: "company.domain", label: "Website / domain", group: "Company" },
  { key: "deal.name", label: "Deal name", group: "Deal" },
  { key: "deal.amount", label: "Amount", group: "Deal" },
  { key: "deal.pipeline", label: "Pipeline", group: "Deal" },
  { key: "deal.stage", label: "Stage", group: "Deal" },
  { key: "deal.closeDate", label: "Close date", group: "Deal" },
  { key: "deal.owner.name", label: "Owner name", group: "Deal" },
  { key: "deal.owner.email", label: "Owner email", group: "Deal" },
  { key: "document.number", label: "Number", group: "Document" },
  { key: "document.title", label: "Title", group: "Document" },
  { key: "document.type", label: "Type", group: "Document" },
  { key: "document.date", label: "Date", group: "Document" },
  { key: "document.version", label: "Version", group: "Document" },
  { key: "document.currency", label: "Currency", group: "Document" },
  { key: "document.subtotal", label: "Subtotal", group: "Document" },
  { key: "document.discountTotal", label: "Discount total", group: "Document" },
  { key: "document.taxTotal", label: "Tax total", group: "Document" },
  { key: "document.total", label: "Total", group: "Document" },
  { key: "document.expirationDate", label: "Expiration date", group: "Document" },
  { key: "document.url", label: "Online link", group: "Document" },
  { key: "sender.name", label: "Sender name", group: "Sender" },
  { key: "sender.email", label: "Sender email", group: "Sender" },
  { key: "organization.name", label: "Company name", group: "Sender" },
  { key: "organization.legalName", label: "Legal name", group: "Sender" },
  { key: "organization.address", label: "Address", group: "Sender" },
  { key: "organization.vatNumber", label: "VAT number", group: "Sender" },
  { key: "organization.registrationNumber", label: "Registration number", group: "Sender" },
];

/** Variables usable in email templates. */
export const EMAIL_VARIABLE_KEYS = [
  "contact.firstName",
  "contact.lastName",
  "contact.fullName",
  "company.name",
  "deal.name",
  "document.number",
  "document.title",
  "document.total",
  "document.expirationDate",
  "document.url",
  "sender.name",
  "sender.email",
  "organization.name",
];

export const VARIABLE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*$/;
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g;

export function extractVariableKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) keys.add(match[1]!);
  return [...keys];
}

export type Escaper = (value: string) => string;

/**
 * Replace {{key}} tokens. Values are passed through `escape` (HTML-escape when
 * interpolating into HTML). Unknown variables resolve to `missing(key)` (default: empty).
 */
export function interpolate(
  text: string,
  values: Record<string, string>,
  escape: Escaper = (v) => v,
  missing: (key: string) => string = () => "",
): string {
  return text.replace(TOKEN_PATTERN, (_, key: string) => {
    const value = values[key];
    return value === undefined || value === "" ? missing(key) : escape(value);
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
