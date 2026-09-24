import nodemailer from "nodemailer";
import { env } from "../env";

/** Email provider abstraction — swap SMTP for an API provider without touching business logic. */
export interface OutgoingEmail {
  from: string;
  replyTo?: string;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface EmailProvider {
  readonly name: string;
  /** Returns the provider message id. Throws on failure. */
  send(message: OutgoingEmail): Promise<string>;
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private transporter = nodemailer.createTransport({
    host: env().SMTP_HOST,
    port: env().SMTP_PORT,
    secure: Boolean(env().SMTP_SECURE),
    auth: env().SMTP_USER ? { user: env().SMTP_USER, pass: env().SMTP_PASSWORD } : undefined,
  });
  async send(message: OutgoingEmail) {
    const info = await this.transporter.sendMail({
      from: message.from,
      replyTo: message.replyTo,
      to: message.to,
      cc: message.cc.length ? message.cc : undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return String(info.messageId);
  }
}

/** Development/test provider: logs emails and keeps them in memory (the "outbox"). */
export class LogEmailProvider implements EmailProvider {
  readonly name = "log";
  readonly outbox: OutgoingEmail[] = [];
  async send(message: OutgoingEmail) {
    this.outbox.push(message);
    if (process.env.NODE_ENV !== "test") {
      console.info(`\n[email] To: ${message.to.join(", ")}${message.cc.length ? ` Cc: ${message.cc.join(", ")}` : ""}\n[email] Subject: ${message.subject}\n${message.text}\n`);
    }
    return `log-${Date.now()}-${this.outbox.length}`;
  }
}

let provider: EmailProvider | null = null;

export function emailProvider(): EmailProvider {
  if (provider) return provider;
  provider = env().EMAIL_PROVIDER === "smtp" ? new SmtpEmailProvider() : new LogEmailProvider();
  return provider;
}

export function setEmailProvider(custom: EmailProvider) {
  provider = custom;
}
