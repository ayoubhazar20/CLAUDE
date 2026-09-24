import crypto from "node:crypto";
import { safeEqual } from "../security/crypto";

/**
 * HubSpot request signature v3 validation (webhooks and hubspot.fetch from UI extensions).
 * signature = base64(HMAC-SHA256(clientSecret, method + uri + body + timestamp))
 * Requests older than 5 minutes are rejected to prevent replay.
 */
const MAX_AGE_MS = 5 * 60 * 1000;

export function computeSignatureV3(secret: string, method: string, uri: string, body: string, timestamp: string): string {
  return crypto.createHmac("sha256", secret).update(`${method}${uri}${body}${timestamp}`, "utf8").digest("base64");
}

/** HubSpot decodes a fixed set of URL-encoded characters before signing. */
export function normaliseUriForSignature(uri: string): string {
  const map: Record<string, string> = {
    "%3A": ":", "%2F": "/", "%3F": "?", "%40": "@", "%21": "!", "%24": "$", "%27": "'",
    "%28": "(", "%29": ")", "%2A": "*", "%2C": ",", "%3B": ";",
  };
  return uri.replace(/%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/gi, (m) => map[m.toUpperCase()] ?? m);
}

export function verifySignatureV3(params: {
  secret: string;
  method: string;
  uri: string;
  body: string;
  signature: string | null;
  timestamp: string | null;
  now?: number;
}): boolean {
  if (!params.secret || !params.signature || !params.timestamp) return false;
  const ts = Number(params.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = params.now ?? Date.now();
  if (Math.abs(now - ts) > MAX_AGE_MS) return false;
  const expected = computeSignatureV3(params.secret, params.method.toUpperCase(), normaliseUriForSignature(params.uri), params.body, params.timestamp);
  return safeEqual(expected, params.signature);
}
