/**
 * Standalone background worker: `npm run worker` (JOB_RUNNER=external).
 * Processes emails, PDFs, HubSpot sync and webhooks outside the web process.
 */
import { startJobWorker } from "../server/jobs/scheduler";

startJobWorker();
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
