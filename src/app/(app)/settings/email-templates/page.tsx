import { requireOrgPage } from "@/server/auth/context";
import { listEmailTemplates } from "@/server/services/email-templates";
import { Card, PageHeader } from "@/components/ui";
import { PERMISSIONS } from "@/domain/permissions";
import { EMAIL_VARIABLE_KEYS } from "@/domain/variables";
import { EmailTemplateForm } from "./form";

export const metadata = { title: "Email templates" };

const DESCRIPTIONS: Record<string, string> = {
  QUOTE_SEND: "Sent with Publish & Send / Send for quotes.",
  CONTRACT_SEND: "Sent with Publish & Send / Send for contracts.",
  REMINDER: "Used for reminders.",
  SIGNED_DOCUMENT: "Sent to clients when a document is accepted or fully signed, with the final PDF.",
};

export default async function EmailTemplatesPage() {
  const ctx = await requireOrgPage(PERMISSIONS.EMAIL_TEMPLATES_MANAGE);
  const templates = await listEmailTemplates(ctx);
  return (
    <>
      <PageHeader title="Email templates" description="Defaults used by the email composer. Users can still edit each email before sending." />
      <p className="mb-4 text-xs text-slate-500">Available variables: {EMAIL_VARIABLE_KEYS.map((k) => `{{${k}}}`).join(" ")}</p>
      <div className="space-y-5">
        {templates.map((t) => (
          <Card key={t.kind} title={t.name}>
            <p className="mb-3 text-sm text-slate-500">{DESCRIPTIONS[t.kind]}</p>
            <EmailTemplateForm kind={t.kind} subject={t.subject} body={t.body} />
          </Card>
        ))}
      </div>
    </>
  );
}
