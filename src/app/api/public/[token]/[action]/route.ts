import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler, readJson } from "@/server/api";
import { requestMetaFrom } from "@/server/request";
import { NotFoundError } from "@/server/errors";
import { randomToken } from "@/server/security/crypto";
import { isProduction } from "@/server/env";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { getSessionFromCookies } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { findPublishedDocument, recordView } from "@/server/documents/public";
import { acceptQuote, rejectDocument, requestActionCode, signDocument, verifyActionCode } from "@/server/documents/signing";

/**
 * Public client actions for /d/{token}. No account needed: identity for
 * acceptance/signature is established with an email OTP per action.
 */
const VISITOR_COOKIE = "dd_v";

export const POST = apiHandler("public.action", async (req: Request, { params }: { params: Promise<{ token: string; action: string }> }) => {
  const { token, action } = await params;
  const meta = requestMetaFrom(req);
  await enforceRateLimit(`public:${meta.ip ?? "unknown"}`, 120, 60);

  switch (action) {
    case "view": {
      const store = await cookies();
      let visitor = store.get(VISITOR_COOKIE)?.value;
      if (!visitor || !/^[A-Za-z0-9_-]{20,64}$/.test(visitor)) visitor = randomToken(18);
      // Organization members previewing their own document are not counted.
      const session = await getSessionFromCookies();
      const doc = await findPublishedDocument(token);
      if (!doc) throw new NotFoundError("Document");
      const internal = session ? (await prisma.organizationMembership.count({ where: { userId: session.userId, organizationId: doc.organizationId } })) > 0 || session.user.isPlatformAdmin : false;
      await recordView({ token, visitorId: visitor, meta, internalViewer: internal });
      const res = NextResponse.json({ ok: true });
      res.cookies.set(VISITOR_COOKIE, visitor, { httpOnly: true, sameSite: "lax", secure: isProduction(), path: `/`, maxAge: 60 * 60 * 24 * 365 });
      return res;
    }
    case "otp": {
      const body = (await readJson(req)) as { recipientId: string; action: "ACCEPT_QUOTE" | "SIGN_CONTRACT" | "REJECT_DOCUMENT" };
      const r = await requestActionCode(token, body, meta);
      return { challengeId: r.challengeId, expiresAt: r.expiresAt, maskedEmail: r.maskedEmail };
    }
    case "verify": {
      const body = z.object({ challengeId: z.string(), code: z.string().max(12) }).parse(await readJson(req));
      const r = await verifyActionCode(token, body, meta);
      return { grant: r.grant, action: r.action };
    }
    case "accept": {
      const body = z.object({ grant: z.string() }).parse(await readJson(req));
      await acceptQuote(token, body, meta);
      return { ok: true };
    }
    case "reject": {
      const body = z.object({ grant: z.string(), reason: z.string().max(2000).optional() }).parse(await readJson(req));
      await rejectDocument(token, body, meta);
      return { ok: true };
    }
    case "sign": {
      const body = (await readJson(req, 600_000)) as Parameters<typeof signDocument>[1];
      const r = await signDocument(token, body, meta);
      return { ok: true, complete: r.complete };
    }
    default:
      throw new NotFoundError("Action");
  }
});
