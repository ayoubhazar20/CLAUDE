import type { HubSpotConnection } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { AppError } from "../errors";
import { decrypt, encrypt } from "../security/crypto";

/** Injectable transport (tests replace it with a fake HubSpot). */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);
export function setHubSpotFetch(fn: FetchLike | null) {
  fetchImpl = fn ?? ((input, init) => fetch(input, init));
}
export function hubspotFetch(input: string, init?: RequestInit) {
  return fetchImpl(input, init);
}

export class HubSpotApiError extends AppError {
  constructor(message: string, public httpStatus: number, public hubspotCategory?: string) {
    super(message, httpStatus === 404 ? 404 : 502, httpStatus === 404 ? "HUBSPOT_NOT_FOUND" : "HUBSPOT_API_ERROR");
  }
}

export class HubSpotDisconnectedError extends AppError {
  constructor(message = "HubSpot is not connected. Ask a Company Admin to connect or reconnect HubSpot.") {
    super(message, 409, "HUBSPOT_DISCONNECTED");
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function exchangeToken(params: Record<string, string>): Promise<TokenResponse> {
  const e = env();
  const body = new URLSearchParams({ client_id: e.HUBSPOT_CLIENT_ID, client_secret: e.HUBSPOT_CLIENT_SECRET, ...params });
  const res = await hubspotFetch(`${e.HUBSPOT_API_BASE}/oauth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { status?: string; message?: string };
  if (!res.ok || !json.access_token) {
    throw new HubSpotApiError(`HubSpot token exchange failed: ${json.message ?? res.status}`, res.status, json.status);
  }
  return json as TokenResponse;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Returns a valid access token, refreshing (with a row lock to avoid races) when needed. */
export async function getAccessToken(connectionId: string): Promise<string> {
  const connection = await prisma.hubSpotConnection.findUnique({ where: { id: connectionId } });
  if (!connection || connection.status === "DISCONNECTED") throw new HubSpotDisconnectedError();
  if (connection.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return decrypt(connection.accessTokenEnc);

  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<HubSpotConnection[]>`SELECT * FROM "hubspot_connections" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
      const locked = rows[0];
      if (!locked) throw new HubSpotDisconnectedError();
      // Another request may have refreshed while we waited for the lock.
      if (locked.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return decrypt(locked.accessTokenEnc);
      const tokens = await exchangeToken({ grant_type: "refresh_token", refresh_token: decrypt(locked.refreshTokenEnc) });
      await tx.hubSpotConnection.update({
        where: { id: connectionId },
        data: {
          accessTokenEnc: encrypt(tokens.access_token),
          refreshTokenEnc: encrypt(tokens.refresh_token ?? decrypt(locked.refreshTokenEnc)),
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          status: "CONNECTED",
          lastError: null,
        },
      });
      return tokens.access_token;
    });
  } catch (error) {
    // Recorded outside the (rolled back) transaction so the admin sees the connection needs attention.
    if (error instanceof HubSpotApiError && error.httpStatus === 400) {
      await prisma.hubSpotConnection.update({
        where: { id: connectionId },
        data: { status: "ERROR", lastError: "Refresh token rejected — reconnect HubSpot.", lastErrorAt: new Date() },
      });
      throw new HubSpotDisconnectedError("The HubSpot connection has expired. Ask a Company Admin to reconnect HubSpot.");
    }
    throw error;
  }
}

export interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<string, { results: { id: string; type: string }[] }>;
}

/** Thin, typed HubSpot CRM API client bound to one connection (one portal). */
export class HubSpotClient {
  constructor(public readonly connectionId: string) {}

  async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const token = await getAccessToken(this.connectionId);
    const res = await hubspotFetch(`${env().HUBSPOT_API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "0");
      await new Promise((r) => setTimeout(r, retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 300 * 2 ** attempt));
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (res.status === 401 && attempt === 0) {
      // Token revoked or expired early — force refresh once.
      await prisma.hubSpotConnection.update({ where: { id: this.connectionId }, data: { expiresAt: new Date(0) } });
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as T & { message?: string; category?: string };
    if (!res.ok) {
      const message = json.message ?? `HubSpot request failed (${res.status})`;
      await prisma.hubSpotConnection
        .update({ where: { id: this.connectionId }, data: { lastError: message.slice(0, 500), lastErrorAt: new Date() } })
        .catch(() => undefined);
      throw new HubSpotApiError(message, res.status, json.category);
    }
    return json;
  }

  getObject(objectType: string, id: string, properties: string[], associations: string[] = []) {
    const qs = new URLSearchParams();
    if (properties.length) qs.set("properties", properties.join(","));
    if (associations.length) qs.set("associations", associations.join(","));
    return this.request<HubSpotObject>("GET", `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}?${qs.toString()}`);
  }

  async batchRead(objectType: string, ids: string[], properties: string[]): Promise<HubSpotObject[]> {
    if (!ids.length) return [];
    const out: HubSpotObject[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const res = await this.request<{ results: HubSpotObject[] }>("POST", `/crm/v3/objects/${objectType}/batch/read`, {
        properties,
        inputs: chunk.map((id) => ({ id })),
      });
      out.push(...res.results);
    }
    return out;
  }

  search(objectType: string, body: Record<string, unknown>) {
    return this.request<{ total: number; results: HubSpotObject[] }>("POST", `/crm/v3/objects/${objectType}/search`, body);
  }

  updateObject(objectType: string, id: string, properties: Record<string, string>) {
    return this.request<HubSpotObject>("PATCH", `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}`, { properties });
  }

  getOwner(ownerId: string) {
    return this.request<{ id: string; firstName?: string; lastName?: string; email?: string }>("GET", `/crm/v3/owners/${encodeURIComponent(ownerId)}`);
  }

  getPipelines(objectType = "deals") {
    return this.request<{ results: { id: string; label: string; stages: { id: string; label: string; displayOrder: number }[] }[] }>("GET", `/crm/v3/pipelines/${objectType}`);
  }

  getProperties(objectType: string) {
    return this.request<{ results: { name: string; label: string; type: string; fieldType: string; groupName: string; hubspotDefined?: boolean; modificationMetadata?: { readOnlyValue?: boolean } }[] }>(
      "GET",
      `/crm/v3/properties/${objectType}`,
    );
  }

  createPropertyGroup(objectType: string, name: string, label: string) {
    return this.request("POST", `/crm/v3/properties/${objectType}/groups`, { name, label, displayOrder: -1 });
  }

  createProperty(objectType: string, def: { name: string; label: string; type: string; fieldType: string; groupName: string; description?: string }) {
    return this.request("POST", `/crm/v3/properties/${objectType}`, def);
  }
}

export async function primaryConnection(organizationId: string) {
  return prisma.hubSpotConnection.findFirst({
    where: { organizationId, status: { in: ["CONNECTED", "ERROR"] } },
    orderBy: [{ isPrimary: "desc" }, { installedAt: "asc" }],
  });
}

export async function requireConnection(organizationId: string) {
  const connection = await primaryConnection(organizationId);
  if (!connection) throw new HubSpotDisconnectedError();
  if (connection.status === "ERROR") throw new HubSpotDisconnectedError("The HubSpot connection needs to be re-authorized. Ask a Company Admin to reconnect HubSpot.");
  return connection;
}
