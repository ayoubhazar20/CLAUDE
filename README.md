# DealDocs

Multi-tenant quote & contract management SaaS integrated with HubSpot.
Companies create quotes and contracts from HubSpot deals, customise them, publish a secure online
version, collect OTP-verified acceptances and electronic signatures, and sync the outcome back to HubSpot.

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
npm test                           # 68 tests: unit + integration against PostgreSQL
npm run typecheck
```

`tests/acceptance-flow.test.ts` executes the complete **V1 acceptance scenario** (section 63 of the
spec) end to end against a real database and a fake HubSpot API: registration → approval → OAuth →
deal import → edits (HubSpot untouched) → locked content → autosave → publish → PDF → send →
view tracking → OTP acceptance → HubSpot writeback & stage change → conversion to contract →
sequential signatures → immutable signed version → signed PDF → revision with the same link →
history & audit logs.

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
    hubspot/     OAuth, API client (token refresh), import, mapping, writeback, webhooks
    pdf/         PDF renderer (same resolved block tree as the web page) + certificate
    email/       Provider abstraction (SMTP / log), layout, delivery tracking
    storage/     Storage abstraction (local private disk / S3-compatible), upload validation
    jobs/        PostgreSQL-backed queue (enqueue, runner, scheduler)
  app/           Next.js routes: (auth), (app) tenant UI, admin (platform), d/[token] (public), api
  components/    UI kit, editors (document editor, template builder, rich text, rule builder)
  worker/        Standalone background worker entry point
hubspot-app/     HubSpot developer project: Deal App Card, settings page, webhooks
prisma/          Schema, migrations (incl. immutability triggers), seed
tests/           Vitest suites + fake HubSpot
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
- **HubSpot** — one OAuth connection per organization (schema supports several), tokens encrypted at
  rest, refresh with row locking, v3 signature validation for webhooks and the App Card, idempotent
  webhook ingestion, async writeback & pipeline automation. Stage ids are read live, never hardcoded.
- **Async jobs** — emails, PDFs, HubSpot sync, webhook processing and expirations run through a
  PostgreSQL queue (`FOR UPDATE SKIP LOCKED`, retries with backoff). Runs inline in the web process by
  default or as a separate worker (`npm run worker`); swappable for Redis/SQS later.
- **Billing-ready** — plans, subscriptions, usage records and limit checks (users, documents/month,
  storage, HubSpot connections) are data-driven; payments are not active in V1.

### Security summary

scrypt password hashing · hashed session tokens, httpOnly/SameSite cookies, idle + absolute expiry ·
login lockout & rate limits · CSP with per-request nonce · CSRF (Server Actions origin check +
same-origin check on mutating API routes) · Zod validation on every write · Prisma parameterised
queries · HTML sanitisation of rich text (write and render) · AES-256-GCM encrypted OAuth tokens ·
OAuth state validation · webhook signature validation · magic-byte upload validation, private storage,
download-only serving with `nosniff` · secrets never logged (audit scrubbing) · errors logged with
trace ids, no stack traces shown to users.

---

## HubSpot setup

1. Create a HubSpot public app (see `hubspot-app/README.md`) and upload the project with `hs project upload`.
2. Set `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` (and optionally `HUBSPOT_REDIRECT_URI`).
3. In DealDocs: *Settings → HubSpot → Connect HubSpot*; then configure *Property mapping*
   (use *Create DealDocs properties* for writeback) and *Pipeline automation*.

## Environments & deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Hostinger (VPS or managed Node.js hosting),
development / staging / production environments, storage, email, workers and backups.

## Localisation

The UI ships in English. Strings used by navigation and common actions live in `src/i18n`; money and
dates go through locale-aware helpers, so additional languages can be added as message catalogues.
