import { execSync } from "node:child_process";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/dealdocs_test?schema=public";

export default function setup() {
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}
