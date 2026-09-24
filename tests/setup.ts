import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Test environment — must be set before any server module reads env().
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/dealdocs_test?schema=public",
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0wMTIzNDU2Nzg5YWJjZGVm",
  SECRET_KEY: "dGVzdC1zZWNyZXQta2V5LTAxMjM0NTY3ODlhYmNkZWZnaGlq",
  EMAIL_PROVIDER: "log",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dealdocs-test-")),
  HUBSPOT_DOCUMENT_OBJECT_TYPE_ID: "2-99999999",
  ZAPIER_ALLOWED_HOSTS: "hooks.zapier.com",
  JOB_RUNNER: "external",
});
