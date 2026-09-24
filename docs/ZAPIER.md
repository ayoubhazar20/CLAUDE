# HubSpot via Zapier

DealDocs is a standalone document platform. It never calls the HubSpot API and never needs HubSpot
OAuth credentials. The only HubSpot concepts it knows are:

- the **HubSpot Deal ID** (stored permanently on each document as `hubspot_deal_id`),
- the **HubSpot custom object record ID** (stored as `hubspot_object_record_id` once Zapier links it),
- the **custom object type ID** (per-organization setting, fallback `HUBSPOT_DOCUMENT_OBJECT_TYPE_ID`),
- CRM data that Zapier pushes to DealDocs (deal snapshots and property updates).

```
HubSpot Deal card ──link──▶ DealDocs (/documents/new?type=quote&dealId=…)
DealDocs ──signed webhook──▶ Zapier ──▶ HubSpot (custom object record, deal properties)
HubSpot ──trigger──▶ Zapier ──authenticated POST──▶ DealDocs (link, deal snapshot, updates)
```

Pipeline / stage changes are **not** done by DealDocs: build them in HubSpot workflows (or Zaps)
that react to the deal properties DealDocs maintains (e.g. `latest_contract_status = signed`).

---

## 1. Setup checklist

1. **HubSpot custom object** "DealDocs Document" associated with Deals, with the properties listed in
   section 4 (at minimum `dealdocs_document_id` — make it *unique* — `document_name`, `document_status`,
   `document_url`, `file_url`). Note its object type id (e.g. `2-12345678`).
2. **Deal properties** (optional) listed in section 5, if you want deal-level status fields.
3. **Deal card**: install the project in `hubspot-app/` (three buttons that only open DealDocs links).
4. In DealDocs → *Settings → HubSpot via Zapier*:
   - enter the object type id,
   - create a Zap with *Webhooks by Zapier → Catch Hook* and paste its URL as the **webhook URL**
     (HTTPS, `hooks.zapier.com` unless `ZAPIER_ALLOWED_HOSTS` says otherwise),
   - **Generate secret**. It is shown once; store it in Zapier only. Rotating it invalidates the old one.
   - optionally rename deal properties, remap status labels, or map HubSpot custom properties to
     template variables (`hs_property = variable.key`; default variable is `hubspot.<property>`).
   - **Send test event** to verify delivery.
5. Enable the integration.

Every outbound and inbound call appears in *Settings → HubSpot via Zapier → Synchronization log*,
where failed events can be retried.

---

## 2. Outbound: DealDocs → Zapier

DealDocs POSTs JSON to the webhook URL from a background queue. Events are stored as
`PENDING → PROCESSING → SUCCESS | FAILED`, retried with exponential backoff (up to 8 attempts), and
can be retried manually. The payload is rebuilt from the **current** document state at delivery time,
so a late retry never sends stale data. `DOCUMENT_PUBLISHED`, `DOCUMENT_ACCEPTED` and
`DOCUMENT_SIGNED` wait (up to 3 minutes) for the PDF so that `file_url` works when HubSpot receives it.

### Headers

| Header | Value |
|--------|-------|
| `X-DealDocs-Event` | event name |
| `X-DealDocs-Event-Id` | unique id of this event (stable across retries) |
| `X-DealDocs-Timestamp` | milliseconds since epoch |
| `X-DealDocs-Signature` | `sha256=` + hex HMAC-SHA256 of `"{timestamp}.{raw body}"` with the integration secret |

Verifying the signature is optional in Zapier (a *Code by Zapier* step can do it) but recommended.

### Events

`DOCUMENT_CREATED`, `DOCUMENT_UPDATED`, `DOCUMENT_PUBLISHED`, `DOCUMENT_SENT`, `DOCUMENT_VIEWED`,
`DOCUMENT_ACCEPTED`, `DOCUMENT_REJECTED`, `DOCUMENT_SIGNED`, `DOCUMENT_EXPIRED`, `DOCUMENT_CANCELLED`,
`DOCUMENT_REVISED`, `DEAL_DATA_REQUESTED`, `DEAL_DATA_REFRESH_REQUESTED`, `TEST_EVENT`.

### Document events

```json
{
  "event": "DOCUMENT_SIGNED",
  "event_id": "8b0c…",
  "occurred_at": "2026-09-24T10:00:00.000Z",
  "hubspot_object_type_id": "2-12345678",
  "details": {},
  "idempotency_key": "2f1e…-uuid",
  "dealdocs_document_id": "2f1e…-uuid",
  "hubspot_deal_id": "9001",
  "hubspot_object_record_id": "5001",
  "link_callback_url": "https://app.example.com/api/integrations/zapier/hubspot-document-linked",
  "document": { "…": "see section 4" },
  "deal_properties": { "latest_contract_status": "signed", "document_signed": "true", "…": "…" }
}
```

**Recommended Zap** (one Zap handles every document event):

1. *Catch Hook*.
2. *HubSpot → Find custom object record* by `dealdocs_document_id` = `idempotency_key`
   (enable *create if not found*, or use a Paths step).
3. *Update* (or *Create*) the record with the fields of `document` and associate it with deal
   `hubspot_deal_id`.
4. If the record was **created**, POST `{ dealdocs_document_id, hubspot_object_record_id }` to
   `link_callback_url` (section 3.1).
5. *Update deal* `hubspot_deal_id` with the keys of `deal_properties` (only if you created them).

Because Zapier always searches by `dealdocs_document_id` first, retries and duplicate deliveries
update the same record — they never create a second one.

### Deal data requests

When a document is created from a deal (and on *Refresh HubSpot data*), DealDocs sends:

```json
{
  "event": "DEAL_DATA_REQUESTED",
  "event_id": "…", "request_id": "…",
  "deal_id": "9001",
  "document_id": "2f1e…-uuid",
  "callback_url": "https://app.example.com/api/integrations/zapier/deal-snapshot",
  "document": { "…": "…" }
}
```

The Zap reads the deal, its associated contacts/company and line items from HubSpot and POSTs a
**deal snapshot** to `callback_url` (section 3.2), echoing `document_id` and `request_id`.

---

## 3. Inbound: Zapier → DealDocs

All endpoints require the organization's integration secret:

```
Authorization: Bearer ddz_…          (or header  X-DealDocs-Secret: ddz_…)
Content-Type: application/json
```

The secret identifies the organization; every id in the body is looked up **inside that
organization only** — a deal id is never an authorization. Invalid/missing secrets get `401`, a
disabled integration `403`, unknown ids `404`, invalid bodies `422`. Requests are rate-limited and
logged. Any request may include an `event_id`: a repeated `event_id` that already succeeded is
acknowledged (`{"ok":true,"duplicate":true}`) without being applied again.

| Method & path | Purpose |
|---------------|---------|
| `GET /api/integrations/zapier/me` | Authentication test (returns organization name) |
| `GET /api/integrations/zapier/documents/{id}` | Current mirror record of a document |
| `POST /api/integrations/zapier/hubspot-document-linked` | Store the HubSpot record id |
| `POST /api/integrations/zapier/deal-snapshot` | Deliver deal data |
| `POST /api/integrations/zapier/hubspot-update` | Push a HubSpot-side change |

### 3.1 `hubspot-document-linked`

```json
{ "dealdocs_document_id": "2f1e…-uuid", "hubspot_object_record_id": "5001", "event_id": "optional" }
```

The first link wins: if the document is already linked to a different record, the call is logged
as a conflict and the existing link is kept (`{"ok":false,"conflict":true,"linkedRecordId":"5001"}`).

### 3.2 `deal-snapshot`

```json
{
  "document_id": "2f1e…-uuid",
  "request_id": "from DEAL_DATA_REQUESTED",
  "deal_id": "9001",
  "deal": { "dealname": "Atlas rollout", "amount": "18500", "deal_currency_code": "MAD",
            "pipeline": "Sales", "dealstage": "Proposal", "closedate": "2026-12-15",
            "owner_name": "Alice", "owner_email": "alice@example.com" },
  "contact":  { "id": "501", "firstname": "Amina", "lastname": "Benali", "email": "amina@client.example",
                "phone": "+212…", "jobtitle": "Operations Director" },
  "contacts": [ { "…": "optional list, same fields" } ],
  "company":  { "id": "601", "name": "Atlas Logistics", "address": "…", "city": "Rabat", "zip": "10000",
                "country": "Morocco", "phone": "…", "domain": "atlas.example" },
  "line_items": [
    { "id": "701", "name": "GPS tracker", "sku": "TRK-100", "description": "…", "quantity": "25",
      "price": "450", "discount_percentage": "5", "tax_rate": "20" }
  ],
  "custom_properties": { "contract_term": "24 months" }
}
```

- HubSpot internal names and friendly names are both accepted (`dealname`/`name`, `closedate`/`close_date`,
  `hs_sku`/`sku`, `hs_discount_percentage`, `discount_amount`, `unit_discount`…).
- `contacts`, `line_items`, `deal`, `company`, `custom_properties` may be real JSON or JSON strings
  (Zapier often sends line items as a string).
- `deal_id` must match the document's deal, otherwise the snapshot is rejected (`422`).

**Manual edits are never silently overwritten.** The first snapshot is applied automatically only
while the draft is still untouched. Otherwise — and for every refresh — it is stored as *pending
review*; the user chooses per section (contact, company, deal, recipient, custom properties) and for
line items *keep / replace / append*. Only drafts are ever changed: published, accepted and signed
versions, signatures, evidence, PDFs and audit history cannot be modified by HubSpot or Zapier.

### 3.3 `hubspot-update`

```json
{
  "dealdocs_document_id": "optional", "hubspot_object_record_id": "optional", "deal_id": "optional",
  "changed_property": "dealname",
  "new_value": "New deal name",
  "updated_at": "2026-09-24T10:00:00Z",
  "event_id": "optional"
}
```

At least one of `dealdocs_document_id`, `hubspot_object_record_id`, `deal_id` is required.

| `changed_property` | Effect |
|--------------------|--------|
| `dealname` / `deal_name` | Updates the deal name shown in DealDocs for all the deal's documents |
| `is_primary` / `dealdocs_is_primary` | Sets the primary document of the deal (single document target) |
| anything else | Queued as HubSpot data *pending review* on the targeted documents |

---

## 4. Custom object properties (`document`)

| Property | Example |
|----------|---------|
| `dealdocs_document_id` | `2f1e…` (unique key) |
| `document_name` | `Quote Q-2026-0001` |
| `document_title` | `Fleet tracking proposal` |
| `document_number` | `Q-2026-0001` |
| `document_type` | `quote` / `contract` |
| `document_status` | `draft`, `published`, `sent`, `viewed`, `awaiting_signature`, `accepted`, `signed`, `rejected`, `expired`, `cancelled` (remappable) |
| `hubspot_deal_id` | `9001` |
| `hubspot_object_record_id` | `5001` (null until linked) |
| `created_at`, `updated_at`, `published_at`, `accepted_at`, `signed_at` | ISO 8601 |
| `document_url` | stable public link `https://…/d/{token}` |
| `file_url` | PDF of the latest published version `https://…/files/{token}/v{n}.pdf` |
| `app_url` | internal DealDocs link (login required) |
| `current_version` | `3` |
| `amount`, `currency` | `22680.00`, `MAD` |
| `recipient_name`, `recipient_email` | primary recipient |
| `document_owner`, `document_owner_email` | DealDocs owner |
| `is_primary`, `is_archived` | booleans |
| `last_sync_at` | ISO 8601 |
| `pdf_ready` | boolean |

`document_url` never changes across revisions; `file_url` points to a specific version, so older
links keep returning the PDF they were created for (the signed PDF when that version was signed).

## 5. Deal properties (`deal_properties`)

Default names (renameable per organization): `latest_quote_status`, `latest_quote_id`,
`latest_quote_url`, `latest_quote_amount`, `latest_contract_status`, `latest_contract_id`,
`latest_contract_url`, `document_signed`, `latest_document_updated_at`. They summarise the newest
non-archived quote and contract of the deal.

## 6. Security notes

- The secret is stored hashed (lookup) and encrypted (signing); it is displayed only once and never
  sent to the browser afterwards or written to logs.
- Webhook URLs must be HTTPS on an allowed host (`ZAPIER_ALLOWED_HOSTS`, default `hooks.zapier.com`);
  redirects are not followed.
- Zapier routes are exempt from the browser CSRF check because they are authenticated by the secret
  and never by cookies.
