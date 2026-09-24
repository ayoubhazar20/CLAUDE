# DealDocs — HubSpot card project

HubSpot developer project (platform 2025.2) containing only the **DealDocs card** on the Deal record.

The card shows three actions and passes the Deal record ID to DealDocs:

| Action | Opens |
|--------|-------|
| + Create Quote | `https://<dealdocs>/documents/new?type=quote&dealId=<dealId>` |
| + Create Contract | `https://<dealdocs>/documents/new?type=contract&dealId=<dealId>` |
| View Documents | `https://<dealdocs>/deals/<dealId>/documents` |

It makes **no HubSpot API calls and holds no credentials**. DealDocs never uses HubSpot OAuth:
all CRM data flows through Zapier (see `docs/ZAPIER.md` in the main repository). If the user is not
signed in to DealDocs, DealDocs asks them to log in and then returns to the requested page.

## Setup

1. Replace `https://app.dealdocs.example` in `src/app/config.js` with your DealDocs URL.
2. Install the CLI and upload:

```bash
npm install -g @hubspot/cli
hs account auth
cd hubspot-app
hs project upload
```

3. In HubSpot, add the card to the Deal record's sidebar (Settings → Objects → Deals → Record customization).

If `hs project upload` reports schema differences, compare the `*-hsmeta.json` files with the current
HubSpot developer documentation for your platform version.
