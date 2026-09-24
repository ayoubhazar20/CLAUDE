# Deploying DealDocs

DealDocs is a standard Node.js (≥ 20.9, recommended 22 LTS) Next.js application backed by PostgreSQL.
Source lives on GitHub; each environment is a separate deployment with its own database and secrets.

| Environment | Branch | Database | `APP_URL` example |
|-------------|--------|----------|-------------------|
| development | any | local PostgreSQL | `http://localhost:3000` |
| staging | `staging` | `dealdocs_staging` | `https://staging.dealdocs.example` |
| production | `main` | `dealdocs_production` | `https://app.dealdocs.example` |

Use a **separate HubSpot app** (or at least separate redirect URL/webhook target) for staging.

---

## 1. Required configuration

All configuration is via environment variables (see `.env.example`). Never commit real values.

| Variable | Notes |
|----------|-------|
| `NODE_ENV=production` | Enables secure cookies and strict key checks |
| `APP_URL` | Public HTTPS URL, no trailing slash |
| `DATABASE_URL` | PostgreSQL connection string (use SSL for remote databases: `?sslmode=require`) |
| `ENCRYPTION_KEY` | 32 random bytes, base64 — encrypts HubSpot tokens. **Back it up**; losing it means reconnecting HubSpot |
| `SECRET_KEY` | 32 random bytes, base64 — HMAC for sessions, OTPs, reset links |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | From the HubSpot app |
| `EMAIL_PROVIDER=smtp`, `SMTP_*`, `EMAIL_FROM` | Hostinger mail or any SMTP provider |
| `STORAGE_DRIVER` | `local` (persistent private directory) or `s3` (any S3-compatible bucket) |
| `JOB_RUNNER` | `inline` (single process) or `external` (run `npm run worker` separately) |
| `TERMS_VERSION`, `PRIVACY_VERSION` | Bump when the legal texts change |

Generate keys: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

---

## 2. Hostinger VPS (recommended)

Tested layout: Ubuntu 22.04/24.04, Node 22, PostgreSQL 16, Nginx, PM2.

```bash
# System packages
sudo apt update && sudo apt install -y nginx postgresql git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2

# Database
sudo -u postgres createuser dealdocs --pwprompt
sudo -u postgres createdb -O dealdocs dealdocs_production

# Application
git clone git@github.com:<org>/<repo>.git /srv/dealdocs && cd /srv/dealdocs
git checkout main
cp .env.example .env && nano .env            # production values
npm ci
npx prisma migrate deploy
npm run build
PLATFORM_ADMIN_EMAIL=you@company.com PLATFORM_ADMIN_PASSWORD='…' npm run admin:create

# Processes (web + background worker)
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
```

Nginx (TLS via `certbot --nginx`):

```nginx
server {
  server_name app.dealdocs.example;
  client_max_body_size 20m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
  }
}
```

Storage: with `STORAGE_DRIVER=local`, set `STORAGE_LOCAL_DIR=/srv/dealdocs-storage` (outside the
repository, owned by the app user, included in backups). Files are never served directly by Nginx.

### Updating

```bash
cd /srv/dealdocs && git pull && npm ci && npx prisma migrate deploy && npm run build && pm2 reload all
```

## 3. Hostinger managed Node.js hosting

Where Hostinger's Node.js web-app hosting is used (GitHub integration):

- Build command: `npm ci && npx prisma migrate deploy && npm run build`
- Start command: `npm start` (or `node .next/standalone/server.js` after `npm run build:standalone`)
- Node version: 22.x
- Set all environment variables in the hosting panel.
- Use `JOB_RUNNER=inline` (single process) unless a second process can be started for `npm run worker`.
- Use a managed/remote PostgreSQL database and `STORAGE_DRIVER=s3` if the filesystem is not
  persistent across deployments.

Prisma engines for Debian (VPS) and RHEL/CloudLinux (managed hosting) are declared in
`prisma/schema.prisma → binaryTargets`.

## 4. Operations

- **Health check**: `GET /api/health` (database connectivity; does not affect analytics).
- **Platform admin**: `/admin` — approvals, suspensions, plans, usage, HubSpot connections,
  system health (queue lag, dead jobs, failed emails/webhooks) and error logs by trace id.
- **Backups**: daily `pg_dump` of the database **and** the storage directory/bucket; keep the
  `ENCRYPTION_KEY` in a secret manager.
- **Seed data** never runs in production (`prisma/seed.ts` refuses when `NODE_ENV=production`).
- **Migrations** are applied with `prisma migrate deploy` only (never `migrate dev`/`reset` on servers).
- **Logs**: `pm2 logs`; unexpected errors are also stored in `error_logs` with their trace id.
