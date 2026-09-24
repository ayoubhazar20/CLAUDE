import { headers } from "next/headers";

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function ipFromHeaders(h: Headers): string | null {
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 64);
  return h.get("x-real-ip")?.slice(0, 64) ?? null;
}

export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return { ip: ipFromHeaders(h), userAgent: h.get("user-agent")?.slice(0, 500) ?? null };
}

export function requestMetaFrom(req: Request): RequestMeta {
  return { ip: ipFromHeaders(req.headers), userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null };
}
