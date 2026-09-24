import { enqueue, registerQueueKick } from "./queue";
import { processDueJobs } from "./runner";
import { registerAllJobHandlers } from "./handlers";

/**
 * Polling job worker. Used inline in the web process (JOB_RUNNER=inline, suitable
 * for single-server Hostinger deployments) or by the standalone worker process.
 */
const POLL_MS = 2000;
const EXPIRY_EVERY_MS = 5 * 60 * 1000;

let started = false;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    while ((await processDueJobs(10)) > 0) {
      /* drain */
    }
  } catch (error) {
    console.error("[jobs] worker tick failed", error);
  } finally {
    running = false;
  }
}

export function startJobWorker() {
  if (started) return;
  started = true;
  registerAllJobHandlers();
  registerQueueKick(() => void tick());
  setInterval(() => void tick(), POLL_MS).unref?.();
  const scheduleExpiry = () =>
    enqueue("documents.expireDue", {}, { dedupeKey: `expire:${Math.floor(Date.now() / EXPIRY_EVERY_MS)}`, maxAttempts: 2 }).catch((e) => console.error("[jobs] schedule failed", e));
  void scheduleExpiry();
  setInterval(scheduleExpiry, EXPIRY_EVERY_MS).unref?.();
  console.info("[jobs] worker started");
}
