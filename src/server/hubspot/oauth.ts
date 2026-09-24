import { prisma } from "../db";
import { appUrl, env } from "../env";
import { audit } from "../audit";
import { AppError, ConflictError } from "../errors";
import { encrypt, hmac, randomToken } from "../security/crypto";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { assertWithinLimit } from "../services/billing";
import { exchangeToken, hubspotFetch } from "./client";
import { PERMISSIONS } from "@/domain/permissions";

const STATE_TTL_MS = 10 * 60 * 1000;

export function redirectUri(): string {
  return env().HUBSPOT_REDIRECT_URI || appUrl("/api/integrations/hubspot/callback");
}

export function hubspotConfigured(): boolean {
  return Boolean(env().HUBSPOT_CLIENT_ID && env().HUBSPOT_CLIENT_SECRET);
}

/** Start OAuth: persist a single-use state bound to the org + user (CSRF protection). */
export async function createAuthorizeUrl(ctx: OrgContext, redirectTo = "/settings/integrations/hubspot"): Promise<string> {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.HUBSPOT_MANAGE);
  if (!hubspotConfigured()) throw new AppError("HubSpot app credentials are not configured on this server.", 500, "HUBSPOT_NOT_CONFIGURED");
  const state = randomToken(32);
  await prisma.oAuthState.create({
    data: {
      stateHash: hmac(state, "oauth-state"),
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      redirectTo: redirectTo.startsWith("/") && !redirectTo.startsWith("//") ? redirectTo : "/settings/integrations/hubspot",
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  const url = new URL("https://app.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", env().HUBSPOT_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", env().HUBSPOT_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenInfo {
  hub_id: number;
  hub_domain?: string;
  scopes?: string[];
  user?: string;
}

/** OAuth callback: validate state, exchange code, store encrypted tokens for this organization. */
export async function completeOAuth(params: { code: string; state: string; currentUserId: string; ip: string | null; userAgent: string | null }) {
  const stateRow = await prisma.oAuthState.findUnique({ where: { stateHash: hmac(params.state, "oauth-state") } });
  if (!stateRow || stateRow.usedAt || stateRow.expiresAt < new Date() || stateRow.userId !== params.currentUserId) {
    throw new AppError("The HubSpot authorization request is invalid or has expired. Please try again.", 400, "INVALID_OAUTH_STATE");
  }
  const consumed = await prisma.oAuthState.updateMany({ where: { id: stateRow.id, usedAt: null }, data: { usedAt: new Date() } });
  if (consumed.count !== 1) throw new AppError("This authorization was already used.", 400, "INVALID_OAUTH_STATE");

  const tokens = await exchangeToken({ grant_type: "authorization_code", code: params.code, redirect_uri: redirectUri() });
  const infoRes = await hubspotFetch(`${env().HUBSPOT_API_BASE}/oauth/v1/access-tokens/${encodeURIComponent(tokens.access_token)}`);
  if (!infoRes.ok) throw new AppError("Could not read HubSpot account information.", 502, "HUBSPOT_API_ERROR");
  const info = (await infoRes.json()) as TokenInfo;
  const portalId = String(info.hub_id);
  const organizationId = stateRow.organizationId;

  const otherOrg = await prisma.hubSpotConnection.findFirst({
    where: { portalId, status: { in: ["CONNECTED", "ERROR"] }, organizationId: { not: organizationId } },
  });
  if (otherOrg) throw new ConflictError("This HubSpot account is already connected to another DealDocs organization.", "HUBSPOT_PORTAL_IN_USE");

  const existing = await prisma.hubSpotConnection.findUnique({ where: { organizationId_portalId: { organizationId, portalId } } });
  if (!existing || existing.status === "DISCONNECTED") await assertWithinLimit(organizationId, "hubspotConnections");
  const hasPrimary = await prisma.hubSpotConnection.count({ where: { organizationId, status: { in: ["CONNECTED", "ERROR"] }, isPrimary: true, portalId: { not: portalId } } });

  const data = {
    hubDomain: info.hub_domain ?? null,
    accessTokenEnc: encrypt(tokens.access_token),
    refreshTokenEnc: encrypt(tokens.refresh_token),
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    scopes: info.scopes ?? env().HUBSPOT_SCOPES.split(/\s+/),
    installedById: params.currentUserId,
    installedAt: new Date(),
    status: "CONNECTED" as const,
    isPrimary: hasPrimary === 0,
    lastError: null,
    disconnectedAt: null,
  };
  const connection = await prisma.hubSpotConnection.upsert({
    where: { organizationId_portalId: { organizationId, portalId } },
    create: { organizationId, portalId, ...data },
    update: data,
  });
  await audit({
    organizationId,
    userId: params.currentUserId,
    action: "HUBSPOT_CONNECTED",
    entityType: "HubSpotConnection",
    entityId: connection.id,
    ip: params.ip,
    userAgent: params.userAgent,
    newValue: { portalId, hubDomain: info.hub_domain, scopes: data.scopes },
  });
  return { connection, redirectTo: stateRow.redirectTo ?? "/settings/integrations/hubspot" };
}

export async function disconnectHubSpot(ctx: OrgContext, connectionId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.HUBSPOT_MANAGE);
  const connection = await prisma.hubSpotConnection.findFirst({ where: { id: connectionId, organizationId: ctx.organizationId } });
  if (!connection) throw new AppError("Connection not found", 404, "NOT_FOUND");
  // Tokens are wiped; history (documents linked to deals) is kept.
  await prisma.hubSpotConnection.update({
    where: { id: connection.id },
    data: { status: "DISCONNECTED", disconnectedAt: new Date(), accessTokenEnc: encrypt(""), refreshTokenEnc: encrypt(""), expiresAt: new Date(0), isPrimary: false },
  });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "HUBSPOT_DISCONNECTED", entityType: "HubSpotConnection", entityId: connection.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, metadata: { portalId: connection.portalId } });
}
