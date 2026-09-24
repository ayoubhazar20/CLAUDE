/**
 * In-memory fake of the HubSpot APIs used by DealDocs. Records every write so
 * tests can assert that HubSpot data was (or was not) modified.
 */
type Props = Record<string, string | null>;

export interface FakeObject {
  id: string;
  properties: Props;
  associations?: Record<string, string[]>;
}

export class FakeHubSpot {
  portalId = "4242";
  accessToken = "access-1";
  refreshToken = "refresh-1";
  tokenCalls: Record<string, string>[] = [];
  writes: { method: string; path: string; body: unknown }[] = [];
  objects: Record<string, Map<string, FakeObject>> = {
    deals: new Map(),
    contacts: new Map(),
    companies: new Map(),
    line_items: new Map(),
    products: new Map(),
  };
  owners = new Map<string, { id: string; firstName: string; lastName: string; email: string }>();
  pipelines = [
    {
      id: "default",
      label: "Sales Pipeline",
      stages: [
        { id: "appointmentscheduled", label: "Appointment scheduled", displayOrder: 0 },
        { id: "proposal_sent", label: "Proposal Sent", displayOrder: 1 },
        { id: "quote_accepted", label: "Quote Accepted", displayOrder: 2 },
        { id: "contract_sent", label: "Contract Sent", displayOrder: 3 },
        { id: "closedwon", label: "Closed Won", displayOrder: 4 },
      ],
    },
  ];
  properties: { name: string; label: string; type: string; fieldType: string; groupName: string; hubspotDefined?: boolean }[] = [
    { name: "dealname", label: "Deal name", type: "string", fieldType: "text", groupName: "dealinformation", hubspotDefined: true },
    { name: "project_start_date", label: "Project start date", type: "date", fieldType: "date", groupName: "dealinformation" },
  ];

  seedDeal() {
    this.owners.set("77", { id: "77", firstName: "Sara", lastName: "Owner", email: "sara.owner@seller.test" });
    this.objects.contacts!.set("501", { id: "501", properties: { firstname: "Amina", lastname: "Client", email: "amina@client.test", phone: "+212 600 000 000", jobtitle: "CEO" } });
    this.objects.contacts!.set("502", { id: "502", properties: { firstname: "Omar", lastname: "Finance", email: "omar@client.test", phone: null, jobtitle: "CFO" } });
    this.objects.companies!.set("601", { id: "601", properties: { name: "Client Co", address: "1 Rue Client", city: "Casablanca", zip: "20000", country: "Morocco", phone: null, domain: "client.test" } });
    this.objects.line_items!.set("701", {
      id: "701",
      properties: { name: "Consulting day", description: "Senior consultant", quantity: "10", price: "1500", hs_sku: "CONS-1", discount: null, hs_discount_percentage: null, hs_product_id: "801", hs_position_on_quote: "0" },
    });
    this.objects.line_items!.set("702", {
      id: "702",
      properties: { name: "Software license", description: null, quantity: "2", price: "1750.50", hs_sku: "LIC", discount: "50", hs_discount_percentage: null, hs_product_id: "802", hs_position_on_quote: "1" },
    });
    this.objects.products!.set("803", { id: "803", properties: { name: "Training", description: "On-site training", price: "900", hs_sku: "TRN" } });
    this.objects.deals!.set("9001", {
      id: "9001",
      properties: {
        dealname: "ACME Expansion",
        amount: "18500",
        pipeline: "default",
        dealstage: "appointmentscheduled",
        closedate: "2026-12-31",
        hubspot_owner_id: "77",
        deal_currency_code: "MAD",
        project_start_date: "2026-10-15",
      },
      associations: { contacts: ["501", "502"], companies: ["601"], "line items": ["701", "702"] },
    });
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private pick(obj: FakeObject, properties: string[]) {
    const props: Props = {};
    for (const p of properties) if (p in obj.properties) props[p] = obj.properties[p] ?? null;
    return props;
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init?.body ? (typeof init.body === "string" ? init.body : String(init.body)) : "";

    if (path === "/oauth/v1/token") {
      const params = Object.fromEntries(new URLSearchParams(body));
      this.tokenCalls.push(params);
      if (params.grant_type === "refresh_token" && params.refresh_token !== this.refreshToken) return this.json({ status: "BAD_REFRESH_TOKEN", message: "invalid" }, 400);
      return this.json({ access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 1800 });
    }
    if (path.startsWith("/oauth/v1/access-tokens/")) {
      return this.json({ hub_id: Number(this.portalId), hub_domain: "acme.hubspot.test", scopes: ["crm.objects.deals.read", "crm.objects.deals.write"], user: "admin@seller.test" });
    }
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== `Bearer ${this.accessToken}`) return this.json({ message: "unauthorized" }, 401);

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/crm\/v3\/objects\/(\w+)\/batch\/read$/)) && method === "POST") {
      const req = JSON.parse(body) as { properties: string[]; inputs: { id: string }[] };
      const store = this.objects[m[1]!]!;
      const results = req.inputs.map((i) => store.get(i.id)).filter(Boolean).map((o) => ({ id: o!.id, properties: this.pick(o!, req.properties) }));
      return this.json({ results });
    }
    if ((m = path.match(/^\/crm\/v3\/objects\/(\w+)\/search$/)) && method === "POST") {
      const req = JSON.parse(body) as { query?: string; properties: string[] };
      const results = [...this.objects[m[1]!]!.values()]
        .filter((o) => !req.query || JSON.stringify(o.properties).toLowerCase().includes(req.query.toLowerCase()))
        .map((o) => ({ id: o.id, properties: this.pick(o, req.properties) }));
      return this.json({ total: results.length, results });
    }
    if ((m = path.match(/^\/crm\/v3\/objects\/(\w+)\/(\w+)$/))) {
      const store = this.objects[m[1]!]!;
      const obj = store.get(m[2]!);
      if (!obj) return this.json({ message: "not found" }, 404);
      if (method === "PATCH") {
        const req = JSON.parse(body) as { properties: Record<string, string> };
        this.writes.push({ method, path, body: req });
        Object.assign(obj.properties, req.properties);
        return this.json({ id: obj.id, properties: obj.properties });
      }
      const properties = (url.searchParams.get("properties") ?? "").split(",").filter(Boolean);
      const assocTypes = (url.searchParams.get("associations") ?? "").split(",").filter(Boolean);
      const associations: Record<string, { results: { id: string; type: string }[] }> = {};
      for (const t of assocTypes) {
        const key = t === "line_items" ? "line items" : t;
        const ids = obj.associations?.[key] ?? [];
        if (ids.length) associations[key] = { results: ids.map((id) => ({ id, type: `deal_to_${t}` })) };
      }
      return this.json({ id: obj.id, properties: this.pick(obj, properties), associations });
    }
    if ((m = path.match(/^\/crm\/v3\/owners\/(\w+)$/))) {
      const o = this.owners.get(m[1]!);
      return o ? this.json(o) : this.json({ message: "not found" }, 404);
    }
    if (path === "/crm/v3/pipelines/deals") return this.json({ results: this.pipelines });
    if ((m = path.match(/^\/crm\/v3\/properties\/(\w+)$/))) {
      if (method === "POST") {
        const def = JSON.parse(body);
        this.writes.push({ method, path, body: def });
        this.properties.push(def);
        return this.json(def, 201);
      }
      return this.json({ results: this.properties });
    }
    if ((m = path.match(/^\/crm\/v3\/properties\/(\w+)\/groups$/)) && method === "POST") {
      this.writes.push({ method, path, body: JSON.parse(body) });
      return this.json({}, 201);
    }
    return this.json({ message: `unhandled ${method} ${path}` }, 404);
  };
}
