import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { authenticate, registerUser, requestPasswordReset, resetPassword, verifyEmail } from "@/server/services/auth";
import { createSession, validateSessionToken, revokeSession } from "@/server/auth/session";
import { hashPassword, verifyPassword, passwordPolicyError } from "@/server/security/password";
import { decrypt, encrypt } from "@/server/security/crypto";
import { createOrganization } from "@/server/services/organizations";
import { META, processJobs, resetDatabase, useOutbox } from "./helpers";

describe("authentication", () => {
  const outbox = useOutbox();
  beforeAll(resetDatabase);

  it("hashes passwords (never plain text) and verifies them", async () => {
    const hash = await hashPassword("Correct-Horse-9");
    expect(hash).not.toContain("Correct-Horse-9");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("Correct-Horse-9", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(passwordPolicyError("short")).not.toBeNull();
    expect(passwordPolicyError("alllowercaseletters")).not.toBeNull();
  });

  it("encrypts integration secrets with authenticated encryption", () => {
    const c = encrypt("secret-token");
    expect(c).not.toContain("secret-token");
    expect(decrypt(c)).toBe("secret-token");
    const tampered = c.slice(0, -2) + (c.endsWith("A") ? "BB" : "AA");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("registers, requires email verification, then logs in", async () => {
    const user = await registerUser({ name: "Bob", email: "Bob@Example.test", password: "Val1d-Password" }, META);
    expect(user.email).toBe("bob@example.test");
    expect(user.emailVerifiedAt).toBeNull();
    await expect(registerUser({ name: "Bob", email: "bob@example.test", password: "Val1d-Password" }, META)).rejects.toThrow(/already exists/);
    await expect(createOrganization(user.id, { name: "Bob Co", country: "MA", addressLine1: "Street", defaultCurrency: "MAD", timezone: "UTC", acceptTerms: true, acceptPrivacy: true }, META)).rejects.toThrow(/verify/i);

    await processJobs();
    const mail = outbox.outbox.find((m) => m.to.includes("bob@example.test"))!;
    const token = decodeURIComponent(mail.html.match(/token=([^"&<\s]+)/)![1]!);
    expect(await verifyEmail("bogus-token", META)).toBeNull();
    expect((await verifyEmail(token, META))?.emailVerifiedAt).not.toBeNull();
    expect(await verifyEmail(token, META)).toBeNull(); // single use

    const logged = await authenticate("BOB@example.test", "Val1d-Password", META);
    expect(logged.id).toBe(user.id);
    await expect(authenticate("bob@example.test", "nope", META)).rejects.toThrow(/Invalid email or password/);
    await expect(authenticate("nobody@example.test", "nope", META)).rejects.toThrow(/Invalid email or password/);
  });

  it("locks the account after repeated failures", async () => {
    await prisma.user.create({ data: { email: "lock@example.test", name: "Lock", passwordHash: await hashPassword("Val1d-Password"), emailVerifiedAt: new Date() } });
    for (let i = 0; i < 10; i++) {
      await expect(authenticate("lock@example.test", "bad", { ...META, ip: `10.0.0.${i}` })).rejects.toThrow();
    }
    await expect(authenticate("lock@example.test", "Val1d-Password", { ...META, ip: "10.0.1.1" })).rejects.toThrow(/Too many/);
  });

  it("resets the password with a single-use token and revokes sessions", async () => {
    const user = await prisma.user.create({ data: { email: "reset@example.test", name: "Reset", passwordHash: await hashPassword("Old-Password1"), emailVerifiedAt: new Date() } });
    const { token: sessionToken } = await createSession(user.id, META);
    expect(await validateSessionToken(sessionToken)).not.toBeNull();

    await requestPasswordReset("reset@example.test", META);
    await requestPasswordReset("unknown@example.test", META); // no error, no leak
    await processJobs();
    const mail = [...outbox.outbox].reverse().find((m) => m.to.includes("reset@example.test"))!;
    const token = decodeURIComponent(mail.html.match(/token=([^"&<\s]+)/)![1]!);
    await expect(resetPassword(token, "weak", META)).rejects.toThrow();
    await resetPassword(token, "New-Password2", META);
    await expect(resetPassword(token, "New-Password3", META)).rejects.toThrow(/invalid or has expired/);
    expect(await validateSessionToken(sessionToken)).toBeNull();
    expect((await authenticate("reset@example.test", "New-Password2", META)).id).toBe(user.id);
  });

  it("sessions are stored hashed, expire, and stop working when revoked or the user is suspended", async () => {
    const user = await prisma.user.create({ data: { email: "sess@example.test", name: "Sess", passwordHash: await hashPassword("Val1d-Password"), emailVerifiedAt: new Date() } });
    const { token, session } = await createSession(user.id, META);
    expect(session.tokenHash).not.toBe(token);
    expect(await validateSessionToken(token)).not.toBeNull();
    await prisma.session.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSessionToken(token)).toBeNull();

    const second = await createSession(user.id, META);
    await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    expect(await validateSessionToken(second.token)).toBeNull();
    await prisma.user.update({ where: { id: user.id }, data: { status: "ACTIVE" } });
    expect(await validateSessionToken(second.token)).not.toBeNull();
    await revokeSession(second.session.id);
    expect(await validateSessionToken(second.token)).toBeNull();
    await expect(authenticate("sess@example.test", "Val1d-Password", META)).resolves.toBeTruthy();
    await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    await expect(authenticate("sess@example.test", "Val1d-Password", META)).rejects.toThrow(/suspended/);
  });
});
