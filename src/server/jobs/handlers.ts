import { deliverEmail } from "../email/service";
import { generateVersionPdf } from "../pdf/service";
import { sendCompletionEmails } from "../documents/signing";
import { expireDueDocuments } from "../documents/public";
import { syncDocumentToHubSpot } from "../hubspot/sync";
import { processWebhookEvent } from "../hubspot/webhooks";
import { registerJobHandler } from "./runner";

let registered = false;

/** Register every background job handler (idempotent). */
export function registerAllJobHandlers() {
  if (registered) return;
  registered = true;
  registerJobHandler("email.send", async (p) => deliverEmail(p as Parameters<typeof deliverEmail>[0]));
  registerJobHandler("pdf.generate", async (p) => {
    await generateVersionPdf(String(p.versionId), { signed: false });
  });
  registerJobHandler("pdf.generateSigned", async (p) => {
    const fileId = await generateVersionPdf(String(p.versionId), { signed: true });
    if (fileId && p.sendConfirmation) await sendCompletionEmails(String(p.versionId));
  });
  registerJobHandler("hubspot.syncDocument", async (p) =>
    syncDocumentToHubSpot({ documentId: String(p.documentId), event: (p.event as Parameters<typeof syncDocumentToHubSpot>[0]["event"]) ?? null }),
  );
  registerJobHandler("hubspot.processWebhook", async (p) => processWebhookEvent({ webhookEventId: String(p.webhookEventId) }));
  registerJobHandler("documents.expireDue", async () => {
    await expireDueDocuments();
  });
}
