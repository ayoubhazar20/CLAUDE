export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if ((process.env.JOB_RUNNER ?? "inline") !== "inline") return;
  const { startJobWorker } = await import("./server/jobs/scheduler");
  startJobWorker();
}
