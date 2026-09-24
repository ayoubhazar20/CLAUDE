import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware:
 *  - Content-Security-Policy with a per-request nonce (Next.js applies it to its scripts).
 *  - CSRF defence for JSON/form API routes: mutating requests must come from our own origin.
 *    (Server Actions have their own built-in origin check; Zapier endpoints are
 *    authenticated with the organization's integration secret instead of cookies.)
 *  - Exposes the requested path to server components (x-pathname) so logged-out users
 *    are sent back to the page they asked for after signing in.
 */
// Server-to-server endpoints authenticated by the Zapier integration secret instead of cookies.
const CSRF_EXEMPT = [/^\/api\/integrations\/zapier\//];

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) return false;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (pathname.startsWith("/api/") && mutating && !CSRF_EXEMPT.some((re) => re.test(pathname)) && !sameOrigin(req)) {
    return NextResponse.json({ error: { message: "Cross-site request blocked", code: "CSRF" } }, { status: 403 });
  }

  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== "production";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "form-action 'self' https://app.hubspot.com",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");

  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  headers.set("x-pathname", `${pathname}${req.nextUrl.search}`);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico).*)" }],
};
