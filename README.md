# DealDocs

Multi-tenant quote & contract management SaaS connected to HubSpot through Zapier.
Companies open DealDocs from a HubSpot deal, create quotes and contracts, customise them, publish a
secure online version, collect OTP-verified acceptances and electronic signatures, and mirror the
outcome back to HubSpot via Zapier. DealDocs never calls the HubSpot API and needs no HubSpot OAuth
credentials.

> Stack: Next.js 15 (App Router) · React 19 · TypeScript (strict) · PostgreSQL 16 · Prisma 6 ·
> Zod · decimal.js · pdf-lib · Tailwind CSS 4 · Vitest

---

## Quick start (development)

```bash
cp .env.example .env               # then fill ENCRYPTION_KEY and SECRET_KEY (see below)
npm install
npx prisma migrate deploy          # creates the schema + integrity triggers
npm run db:seed                    # demo data (refuses to run in production)
npm run dev                        # http://localhost:3000
```

Generate keys: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

With `EMAIL_PROVIDER=log`, emails (verification links, OTP codes…) are printed in the server console.

### Demo accounts (seed) — password `DealDocs!2026`

| Role | Email |
|------|-------|
| Platform Super Admin | `platform@dealdocs.local` |
| Company Admin | `admin@demo.local` |
| Manager | `manager@demo.local` |
| User | `user@demo.local` |
| Viewer | `viewer@demo.local` |

The seed creates the *Demo Organization* with a Sales team, custom variables, quote & contract
templates, a draft quote, a published quote and a signed contract (links printed at the end of the seed).

### Tests

```bash
createdb dealdocs_test             # once
npm test                           # 73 tests: unit + integration against PostgreSQL
npm run typecheck
```

`tests/acceptance-flow.test.ts` executes the complete **V1 acceptance scenario** (section 63 of the
spec) end to end against a real database and a fake Zapier/HubSpot: registration → approval →
Zapier setup → document from a deal → deal snapshot via Zapier → edits → locked content → autosave →
publish → PDF → send → view tracking → OTP acceptance → custom object & deal properties mirrored via
Zapier (stage change by a HubSpot workflow) → conversion to contract →
sequential signatures → immutable signed version → signed PDF → revision with the same link →
history & audit logs. `tests/zapier.test.ts` covers authentication, cross-organization isolation,
retries without duplicate records, signatures, snapshot review and HubSpot updates.

---

## Architecture

```
src/
  domain/        Pure business logic (no I/O): pricing engine, blocks, variables, conditions,
                 statuses, permissions, numbering, resolve (shared render tree), HTML renderer
  server/
    auth/        Sessions (hashed tokens, httpOnly cookies), OrgContext, page/API guards
    security/    AES-256-GCM encryption, HMAC, scrypt passwords, DB-backed rate limiting
    services/    Auth, organizations, members/teams, roles, templates, billing, notifications…
    documents/   Access control, create/edit/publish/revise, send, public page, OTP, signing
    integrations/ Zapier bridge: settings & secret, outbound event queue, inbound endpoints, deal snapshots
    pdf/         PDF renderer (same resolved block tree as the web page) + certificate
    email/       Provider abstraction (SMTP / log), layout, delivery tracking
    storage/     Storage abstraction (local private disk / S3-compatible), upload validation
    jobs/        PostgreSQL-backed queue (enqueue, runner, scheduler)
  app/           Next.js routes: (auth), (app) tenant UI, admin (platform), d/[token] (public), api
  components/    UI kit, editors (document editor, template builder, rich text, rule builder)
  worker/        Standalone background worker entry point
hubspot-app/     HubSpot Deal card (links into DealDocs only, no API calls)
prisma/          Schema, migrations (incl. immutability triggers), seed
tests/           Vitest suites + fake Zapier/HubSpot
```

### Key design decisions

- **Tenant isolation** — every tenant table has `organizationId`. Services receive a server-built
  `OrgContext`; organization ids from the browser are never trusted. Document access is filtered by
  permission scope (all / team / own) and inaccessible records behave as *not found* (no IDOR leaks).
- **Permissions, not role names** — roles are rows with permission sets (`role_permissions`), so custom
  roles need no code change. Platform admins get a separate, read-only, audited *support view*.
- **Versioning & immutability** — a document has one stable public token (`/d/{token}`) and many
  versions. Publishing locks a version (rendered HTML snapshot + SHA-256 content hash). PostgreSQL
  triggers reject any modification of locked versions and their line items, and make audit logs,
  document events, status history and signatures append-only — even a buggy code path cannot rewrite
  signed evidence. Revisions create a new draft version; signed versions stay intact.
- **Templates are versioned** — documents copy the template version they were created from; editing a
  template creates a new version and never changes existing documents. Locked blocks are validated
  server-side on every save.
- **Money** — decimal.js with explicit half-up rounding to currency minor units; deterministic,
  documented calculation order (`src/domain/pricing.ts`), covered by tests. Currency never auto-converts.
- **One renderer** — `resolveDocument()` turns blocks + data into a render tree consumed by the HTML
  renderer (editor preview, public page, stored snapshot) and the PDF renderer.
- **OTP** — 6 digits, 10-minute expiry, 5 attempts, resend cooldown, rate limits; only an HMAC bound to
  (challenge, document, version, recipient, email, action) is stored. A verified OTP yields a
  single-use grant consumed by the final action.
- **HubSpot via Zapier** — DealDocs stores only the deal id, the custom object record id and the
  object type id. Document lifecycle events go to a per-organization Zapier webhook through a durable
  queue (HMAC-signed, retried, never duplicated: Zapier finds records by `dealdocs_document_id`).
  Zapier calls back with a per-organization secret to link records, deliver deal snapshots and push
  HubSpot changes. Snapshots never silently overwrite manual edits, and nothing from HubSpot can touch
  locked versions, signatures, PDFs or audit history. Pipeline changes live in HubSpot workflows.
  See [`docs/ZAPIER.md`](docs/ZAPIER.md).
- **Async jobs** — emails, PDFs, Zapier deliveries and expirations run through a
  PostgreSQL queue (`FOR UPDATE SKIP LOCKED`, retries with backoff). Runs inline in the web process by
  default or as a separate worker (`npm run worker`); swappable for Redis/SQS later.
- **Billing-ready** — plans, subscriptions, usage records and limit checks (users, documents/month,
  storage) are data-driven; payments are not active in V1.

### Security summary

scrypt password hashing · hashed session tokens, httpOnly/SameSite cookies, idle + absolute expiry ·
login lockout & rate limits · CSP with per-request nonce · CSRF (Server Actions origin check +
same-origin check on mutating API routes) · Zod validation on every write · Prisma parameterised
queries · HTML sanitisation of rich text (write and render) · AES-256-GCM encrypted integration secrets ·
HMAC-signed outbound webhooks · hashed per-organization Zapier secrets · SSRF-restricted webhook hosts · magic-byte upload validation, private storage,
download-only serving with `nosniff` · secrets never logged (audit scrubbing) · errors logged with
trace ids, no stack traces shown to users.

---

## HubSpot setup (via Zapier)

1. Install the Deal card from `hubspot-app/` (buttons *Create Quote*, *Create Contract*,
   *View Documents* — plain links to `APP_URL`).
2. Create the *DealDocs Document* custom object in HubSpot (properties in `docs/ZAPIER.md`).
3. In DealDocs: *Settings → HubSpot via Zapier*: object type id, Zapier catch-hook URL, generate the
   integration secret, send a test event, enable.
4. Build the Zaps described in [`docs/ZAPIER.md`](docs/ZAPIER.md).

## Environments & deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Hostinger (VPS or managed Node.js hosting),
development / staging / production environments, storage, email, workers and backups.

## Localisation

The UI ships in English. Strings used by navigation and common actions live in `src/i18n`; money and
dates go through locale-aware helpers, so additional languages can be added as message catalogues.
