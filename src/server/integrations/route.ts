import type { ZapierIntegration } from "@prisma/client";
import { NextResponse } from "next/server";
import { readJson } from "../api";
import { toErrorResponse } from "../errors";
import { requestMetaFrom, type RequestMeta } from "../request";
import { authenticateZapier, logInbound } from "./inbound";

/**
 * Wrapper for Zapier-facing endpoints: authenticate the integration secret,
 * parse JSON, run the handler and log failures in the synchronization log.
 */
export function zapierRoute(eventType: string, handler: (integration: ZapierIntegration, body: unknown, meta: RequestMeta, req: Request, params: Record<string, string>) => Promise<unknown>) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    const meta = requestMetaFrom(req);
    let integration: ZapierIntegration | null = null;
    try {
      integration = await authenticateZapier(req, meta);
      const body = req.method === "GET" ? {} : await readJson(req, 2_000_000);
      const result = await handler(integration, body, meta, req, await ctx.params);
      return NextResponse.json(result ?? { ok: true });
    } catch (error) {
      const { status, body, headers } = await toErrorResponse(error, `zapier:${eventType}`, { organizationId: integration?.organizationId ?? null });
      if (integration) {
        await logInbound(integration.organizationId, { eventType, success: false, message: `Rejected: ${body.error.message}`, details: { status, code: body.error.code }, ip: meta.ip }).catch(() => undefined);
      }
      return NextResponse.json(body, { status, headers });
    }
  };
}
