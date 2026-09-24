/**
 * PM2 process file (Hostinger VPS).
 *   pm2 start ecosystem.config.js --env production
 * Web: Next.js server. Worker: background jobs (emails, PDFs, HubSpot sync).
 * With a separate worker set JOB_RUNNER=external for the web process.
 */
module.exports = {
  apps: [
    {
      name: "dealdocs-web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: 1,
      env_production: { NODE_ENV: "production", JOB_RUNNER: "external" },
      max_memory_restart: "700M",
    },
    {
      name: "dealdocs-worker",
      script: "node_modules/.bin/tsx",
      args: "src/worker/index.ts",
      instances: 1,
      env_production: { NODE_ENV: "production" },
      max_memory_restart: "500M",
    },
  ],
};
