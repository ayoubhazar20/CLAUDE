# DealDocs — HubSpot app project

HubSpot developer-platform project (platform version 2025.2) containing:

| Component | Path | Purpose |
|-----------|------|---------|
| App (OAuth, scopes, permitted URLs) | `src/app/app-hsmeta.json` | Public app installed per customer portal |
| Deal sidebar card **DealDocs** | `src/app/cards/` | Lists the deal's quotes/contracts, "+ Create Document" → Quote / Contract opens DealDocs with the deal preloaded |
| App settings page | `src/app/settings/` | Connection status + deep links into DealDocs |
| Webhooks | `src/app/webhooks/webhooks-hsmeta.json` | Deal name changes / deletions → DealDocs |

## Before uploading

Replace `https://app.dealdocs.example` with your DealDocs URL in:

- `src/app/config.js`
- `src/app/app-hsmeta.json` (`redirectUrls`, `permittedUrls`)
- `src/app/webhooks/webhooks-hsmeta.json` (`targetUrl`)

The redirect URL must equal `HUBSPOT_REDIRECT_URI` (or `APP_URL/api/integrations/hubspot/callback`) on the server,
and the app's client id / secret go into `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET`.

## Upload

```bash
npm install -g @hubspot/cli
hs account auth            # authenticate your developer account
cd hubspot-app
hs project upload
```

Security: the card and settings page call DealDocs with `hubspot.fetch`, which signs every request
(`X-HubSpot-Signature-v3`). DealDocs verifies the signature with the app client secret and maps the
portal id to the connected organization. No OAuth tokens are ever exposed to the card.

The HubSpot platform evolves quickly; if `hs project upload` reports schema differences, compare the
`*-hsmeta.json` files with the current HubSpot developer documentation for your platform version.
