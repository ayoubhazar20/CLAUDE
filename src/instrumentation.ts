export async function register() {
  // NEXT_RUNTIME is inlined at build time, so the Node-only worker is excluded from the edge bundle.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
