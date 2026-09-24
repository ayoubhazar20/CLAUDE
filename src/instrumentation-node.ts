import { startJobWorker } from "./server/jobs/scheduler";

// Inline job runner for single-process deployments (JOB_RUNNER=inline, the default).
if ((process.env.JOB_RUNNER ?? "inline") === "inline") {
  startJobWorker();
}
