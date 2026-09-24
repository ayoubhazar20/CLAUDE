import type { EmailTemplateKind } from "@prisma/client";
import { createBlock, type Block } from "@/domain/blocks";

/** Starter templates and email templates provisioned for every new organization. */

function locked<T extends Block>(block: T): T {
  return { ...block, locked: true };
}

export function starterQuoteBlocks(): Block[] {
  return [
    createBlock("logo", { align: "left" }),
    createBlock("heading", { text: "Quote {{document.number}}", level: 1 }),
    createBlock("paragraph", { text: "{{deal.name}}" }),
    createBlock("companyInfo", {}),
    createBlock("clientInfo", {}),
    createBlock("dealInfo", { title: "Quote details", fields: ["document.number", "document.date", "document.expirationDate", "deal.owner.name"] }),
    createBlock("paragraph", {
      text: "Dear {{contact.firstName}},\n\nThank you for your interest. Please find below our proposal for {{company.name}}.",
    }),
    createBlock("productTable", {}),
    createBlock("pricingSummary", {}),
    locked(
      createBlock("terms", {
        title: "Terms & Conditions",
        html: "<p>This quote is valid until {{document.expirationDate}}. Prices are expressed in {{document.currency}}.</p><ul><li>Payment terms: 30 days from invoice date.</li><li>Delivery dates are confirmed upon acceptance.</li></ul>",
      }),
    ),
    createBlock("acceptanceArea", {}),
  ];
}

export function starterContractBlocks(): Block[] {
  const consulting = createBlock("conditionalSection", { title: "" });
  consulting.condition = { match: "all", rules: [{ field: "lineItems.category", operator: "equals", value: "Consulting" }] };
  consulting.children = [
    createBlock("clause", {
      title: "Professional services",
      html: "<p>Consulting services are delivered on a time-and-materials basis unless stated otherwise in the pricing section.</p>",
    }),
  ];
  return [
    createBlock("logo", { align: "left" }),
    createBlock("heading", { text: "Service Agreement {{document.number}}", level: 1 }),
    createBlock("companyInfo", { title: "Provider" }),
    createBlock("clientInfo", { title: "Client" }),
    createBlock("dealInfo", { title: "Agreement details", fields: ["document.number", "document.date", "deal.owner.name"] }),
    createBlock("heading", { text: "1. Scope of services", level: 2 }),
    createBlock("richText", {
      html: "<p>The Provider agrees to deliver to {{company.name}} the products and services described below.</p>",
    }),
    createBlock("productTable", {}),
    createBlock("pricingSummary", {}),
    locked(
      createBlock("clause", {
        title: "2. Payment",
        html: "<p>The Client shall pay the total amount of {{document.total}} according to the agreed payment schedule. Late payments may incur interest as permitted by law.</p>",
      }),
    ),
    locked(
      createBlock("clause", {
        title: "3. Confidentiality",
        html: "<p>Each party shall keep confidential all information received from the other party and shall not disclose it to third parties without prior written consent.</p>",
      }),
    ),
    consulting,
    locked(
      createBlock("clause", {
        title: "4. Governing law",
        html: "<p>This agreement is governed by the laws applicable at the Provider's registered office.</p>",
      }),
    ),
    createBlock("signatureArea", { title: "Signatures", text: "By signing, the parties agree to the terms of this agreement." }),
  ];
}

export const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateKind, { name: string; subject: string; body: string }> = {
  QUOTE_SEND: {
    name: "Quote email",
    subject: "Quote {{document.number}} from {{organization.name}}",
    body: "Hello {{contact.firstName}},\n\nPlease find our quote {{document.number}} for {{deal.name}}. You can review and accept it online using the button below.\n\nTotal: {{document.total}}\nValid until: {{document.expirationDate}}\n\nBest regards,\n{{sender.name}}\n{{organization.name}}",
  },
  CONTRACT_SEND: {
    name: "Contract email",
    subject: "Contract {{document.number}} from {{organization.name}} — signature requested",
    body: "Hello {{contact.firstName}},\n\nPlease review and sign contract {{document.number}} using the button below. You will receive a one-time verification code by email before signing.\n\nBest regards,\n{{sender.name}}\n{{organization.name}}",
  },
  REMINDER: {
    name: "Reminder email",
    subject: "Reminder: {{document.title}} ({{document.number}})",
    body: "Hello {{contact.firstName}},\n\nThis is a friendly reminder that {{document.number}} is awaiting your review.\n\nBest regards,\n{{sender.name}}\n{{organization.name}}",
  },
  SIGNED_DOCUMENT: {
    name: "Completed document email",
    subject: "{{document.title}} {{document.number}} — completed",
    body: "Hello {{contact.firstName}},\n\nThank you. {{document.number}} has been completed. A copy of the final document is attached for your records.\n\nBest regards,\n{{organization.name}}",
  },
};
