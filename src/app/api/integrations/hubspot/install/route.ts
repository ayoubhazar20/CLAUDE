import { NextResponse } from "next/server";
import { requireOrgApi } from "@/server/auth/context";
import { createAuthorizeUrl } from "@/server/hubspot/oauth";
import { appUrl } from "@/server/env";
import { AppError, logError } from "@/server/errors";

/** Starts the HubSpot OAuth install for the current organization. */
export async function GET(req: Request) {
  try {
    const ctx = await requireOrgApi();
    const redirectTo = new URL(req.url).searchParams.get("redirectTo") ?? "/settings/integrations/hubspot";
    return NextResponse.redirect(await createAuthorizeUrl(ctx, redirectTo));
  } catch (error) {
    const message = error instanceof AppError ? error.message : `Could not start HubSpot connection (ref ${await logError(error, { source: "hubspot.install" })})`;
    const target = error instanceof AppError && error.status === 401 ? "/login" : `/settings/integrations/hubspot?error=${encodeURIComponent(message)}`;
    return NextResponse.redirect(appUrl(target));
  }
}
