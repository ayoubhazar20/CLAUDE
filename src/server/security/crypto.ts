import crypto from "node:crypto";
import { env } from "../env";

/**
 * Cryptographic helpers.
 *  - encrypt/decrypt: AES-256-GCM for secrets at rest (OAuth tokens …).
 *  - hmac: keyed hashes for tokens we only need to compare (sessions, OTPs, reset links).
 */

function keyFrom(value: string, label: string): Buffer {
  const raw = Buffer.from(value, "base64");
  if (raw.length >= 32) return raw.subarray(0, 32);
  // Development convenience: derive a key from a short secret (rejected in production by env()).
  return crypto.createHash("sha256").update(`${label}:${value}`).digest();
}

let encKey: Buffer | null = null;
let macKey: Buffer | null = null;
const encryptionKey = () => (encKey ??= keyFrom(env().ENCRYPTION_KEY, "enc"));
const secretKey = () => (macKey ??= keyFrom(env().SECRET_KEY, "mac"));

const VERSION = "v1";

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decrypt(payload: string): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unsupported ciphertext format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export function hmac(value: string, purpose: string): string {
  return crypto.createHmac("sha256", secretKey()).update(`${purpose}\u0000${value}`).digest("base64url");
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

const PUBLIC_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/** Long, random, non-sequential public identifier (for /d/{token}). */
export function publicToken(length = 32): string {
  const out: string[] = [];
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0]!;
    // Rejection sampling keeps the distribution uniform.
    if (byte < Math.floor(256 / PUBLIC_ALPHABET.length) * PUBLIC_ALPHABET.length) {
      out.push(PUBLIC_ALPHABET[byte % PUBLIC_ALPHABET.length]!);
    }
  }
  return out.join("");
}

/** Uniform random numeric code, e.g. 6-digit OTP. */
export function numericCode(digits = 6): string {
  return crypto.randomInt(0, 10 ** digits).toString().padStart(digits, "0");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Canonical JSON (sorted keys) for hashing structured snapshots deterministically. */
export function canonicalJson(value: unknown): string {
  const normalise = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(normalise);
    const obj = v as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        if (obj[key] !== undefined) acc[key] = normalise(obj[key]);
        return acc;
      }, {});
  };
  return JSON.stringify(normalise(value));
}
