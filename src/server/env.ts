import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required"),
  SECRET_KEY: z.string().min(1, "SECRET_KEY is required"),
  /** Default HubSpot custom object type id for documents (per-organization setting overrides it). */
  HUBSPOT_DOCUMENT_OBJECT_TYPE_ID: z.string().optional().default(""),
  /** Hosts allowed as outbound Zapier webhook targets (SSRF protection), comma separated. */
  ZAPIER_ALLOWED_HOSTS: z.string().default("hooks.zapier.com"),
  EMAIL_PROVIDER: z.enum(["smtp", "log"]).default("log"),
  EMAIL_FROM: z.string().default("DealDocs <no-reply@example.com>"),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_ENDPOINT: z.string().optional().default(""),
  S3_REGION: z.string().optional().default("auto"),
  S3_BUCKET: z.string().optional().default(""),
  S3_ACCESS_KEY_ID: z.string().optional().default(""),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  JOB_RUNNER: z.enum(["inline", "external"]).default("inline"),
  TERMS_VERSION: z.string().default("2026-01"),
  PRIVACY_VERSION: z.string().default("2026-01"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Validated server environment. Never import this from client components. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  if (parsed.data.NODE_ENV === "production") {
    for (const key of ["ENCRYPTION_KEY", "SECRET_KEY"] as const) {
      if (Buffer.from(parsed.data[key], "base64").length < 32) {
        throw new Error(`${key} must be at least 32 random bytes (base64) in production`);
      }
    }
  }
  cached = parsed.data;
  return cached;
}

export function appUrl(path = ""): string {
  return `${env().APP_URL.replace(/\/$/, "")}${path}`;
}

export function isProduction(): boolean {
  return env().NODE_ENV === "production";
}
