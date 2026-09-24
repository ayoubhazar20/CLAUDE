import crypto from "node:crypto";
import { POST as linkRoute } from "@/app/api/integrations/zapier/hubspot-document-linked/route";
import { POST as snapshotRoute } from "@/app/api/integrations/zapier/deal-snapshot/route";
import { POST as updateRoute } from "@/app/api/integrations/zapier/hubspot-update/route";

/**
 * Fake Zapier + HubSpot. Implements the recommended Zap:
 *   document event → find custom object by dealdocs_document_id → update, else create + associate to deal
 *   → POST record id back to DealDocs; deal properties updated; a "HubSpot workflow" moves the
 *   deal to Closed Won when latest_contract_status = signed.
 *   DEAL_DATA_* → POST the deal snapshot back to DealDocs.
 */
export class FakeZapier {
  readonly webhookUrl = "https://hooks.zapier.com/hooks/catch/123/abc/";
  secret = "";
  received: Record<string, any>[] = [];
  failNext = 0;
  /** HubSpot custom object records keyed by record id. */
  records = new Map<string, { properties: Record<string, unknown>; associatedDealId: string | null }>();
  createCalls = 0;
  deals: Record<string, { properties: Record<string, string>; snapshot: Record<string, unknown> }> = {};
  signatureErrors = 0;
  private nextRecordId = 5000;

  seedDeal() {
    this.deals["9001"] = {
      properties: { dealname: "ACME Expansion", dealstage: "appointmentscheduled" },
      snapshot: {
        deal: { id: "9001", dealname: "ACME Expansion", amount: "18500", pipeline: "Sales Pipeline", dealstage: "Proposal", closedate: "2026-12-31", owner_name: "Sara Owner", owner_email: "sara.owner@seller.test", currency: "MAD" },
        contact: { id: "501", firstname: "Amina", lastname: "Client", email: "amina@client.test", phone: "+212 600 000 000", jobtitle: "CEO" },
        company: { id: "601", name: "Client Co", address: "1 Rue Client", city: "Casablanca", zip: "20000", country: "Morocco" },
        // Zapier frequently flattens arrays into JSON strings — DealDocs accepts both.
        line_items: JSON.stringify([
          { id: "701", name: "Consulting day", description: "Senior consultant", quantity: "10", price: "1500", hs_sku: "CONS-1", hs_product_id: "801" },
          { id: "702", name: "Software license", quantity: "2", price: "1750.50", discount: "50", hs_product_id: "802" },
        ]),
        custom_properties: { project_start_date: "2026-10-15" },
      },
    };
  }

  private async call(route: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>, url: string, body: unknown, secret = this.secret) {
    const res = await route(
      new Request(`http://localhost:3000${url}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, "x-forwarded-for": "34.1.2.3" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({}) },
    );
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  link(body: unknown, secret?: string) {
    return this.call(linkRoute, "/api/integrations/zapier/hubspot-document-linked", body, secret);
  }
  snapshot(body: unknown, secret?: string) {
    return this.call(snapshotRoute, "/api/integrations/zapier/deal-snapshot", body, secret);
  }
  update(body: unknown, secret?: string) {
    return this.call(updateRoute, "/api/integrations/zapier/hubspot-update", body, secret);
  }

  recordFor(documentId: string) {
    return [...this.records.entries()].find(([, r]) => r.properties.dealdocs_document_id === documentId);
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url !== this.webhookUrl) return new Response("unknown hook", { status: 404 });
    if (this.failNext > 0) {
      this.failNext -= 1;
      return new Response("temporary failure", { status: 503 });
    }
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    const expected = `sha256=${crypto.createHmac("sha256", this.secret).update(`${headers.get("x-dealdocs-timestamp")}.${body}`).digest("hex")}`;
    if (headers.get("x-dealdocs-signature") !== expected) {
      this.signatureErrors += 1;
      return new Response("bad signature", { status: 401 });
    }
    const payload = JSON.parse(body) as Record<string, any>;
    this.received.push(payload);

    if (payload.event === "DEAL_DATA_REQUESTED" || payload.event === "DEAL_DATA_REFRESH_REQUESTED") {
      const deal = this.deals[payload.deal_id];
      if (deal) await this.snapshot({ document_id: payload.document_id, deal_id: payload.deal_id, request_id: payload.request_id, ...deal.snapshot });
      return new Response("ok");
    }
    if (payload.event === "TEST_EVENT") return new Response("ok");

    // Find custom object by dealdocs_document_id → update, else create + associate.
    const doc = payload.document;
    const existing = this.recordFor(doc.dealdocs_document_id);
    let recordId: string;
    if (existing) {
      recordId = existing[0];
      Object.assign(existing[1].properties, doc);
    } else {
      recordId = String(this.nextRecordId++);
      this.createCalls += 1;
      this.records.set(recordId, { properties: { ...doc }, associatedDealId: doc.hubspot_deal_id });
    }
    if (!doc.hubspot_object_record_id) await this.link({ dealdocs_document_id: doc.dealdocs_document_id, hubspot_object_record_id: recordId });
    const deal = doc.hubspot_deal_id ? this.deals[doc.hubspot_deal_id] : undefined;
    if (deal) {
      Object.assign(deal.properties, payload.deal_properties);
      // HubSpot workflow outside DealDocs: signed contract → Closed Won.
      if (deal.properties.latest_contract_status === "signed") deal.properties.dealstage = "closedwon";
    }
    return new Response(JSON.stringify({ status: "success" }), { status: 200 });
  };
}
