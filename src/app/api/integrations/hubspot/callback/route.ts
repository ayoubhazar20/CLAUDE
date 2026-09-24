import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/context";
import { completeOAuth } from "@/server/hubspot/oauth";
import { appUrl } from "@/server/env";
import { requestMetaFrom } from "@/server/request";
import { AppError, logError } from "@/server/errors";

/** OAuth redirect target: validates state, exchanges the code and stores encrypted tokens. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const fail = (message: string) => NextResponse.redirect(appUrl(`/settings/integrations/hubspot?error=${encodeURIComponent(message)}`));
  if (url.searchParams.get("error")) return fail(url.searchParams.get("error_description") ?? "HubSpot authorization was cancelled.");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail("Missing authorization code.");
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(appUrl("/login"));
  try {
    const meta = requestMetaFrom(req);
    const { redirectTo } = await completeOAuth({ code, state, currentUserId: user.id, ip: meta.ip, userAgent: meta.userAgent });
    const sep = redirectTo.includes("?") ? "&" : "?";
    return NextResponse.redirect(appUrl(`${redirectTo}${sep}connected=1`));
  } catch (error) {
    if (error instanceof AppError) return fail(error.message);
    return fail(`Could not connect HubSpot (ref ${await logError(error, { source: "hubspot.callback", userId: user.id })}).`);
  }
}
