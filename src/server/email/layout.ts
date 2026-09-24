import { escapeHtml } from "@/domain/variables";

/** Minimal, email-client-safe HTML layout with light branding. */
export function renderEmailLayout(params: {
  brandName: string;
  brandColor?: string;
  bodyHtml: string;
  action?: { label: string; url: string };
  footer?: string;
}): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(params.brandColor ?? "") ? params.brandColor! : "#2563eb";
  const button = params.action
    ? `<p style="margin:28px 0"><a href="${escapeHtml(params.action.url)}" style="background:${color};color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;display:inline-block">${escapeHtml(params.action.label)}</a></p>
       <p style="font-size:12px;color:#6b7280">If the button does not work, copy this link: <br><span style="word-break:break-all">${escapeHtml(params.action.url)}</span></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="border-top:4px solid ${color};padding:24px 32px 8px;font-weight:700;font-size:18px">${escapeHtml(params.brandName)}</td></tr>
<tr><td style="padding:8px 32px 32px;font-size:15px;line-height:1.6">${params.bodyHtml}${button}</td></tr>
</table>
<p style="font-size:12px;color:#9ca3af;margin-top:16px">${escapeHtml(params.footer ?? "Sent with DealDocs")}</p>
</td></tr></table></body></html>`;
}

/** Convert plain-text email body (with blank-line paragraphs) to safe HTML. */
export function textToEmailHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
