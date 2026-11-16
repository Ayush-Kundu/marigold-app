/** Load the agent tools at server start so saved alarms and monitors re-arm without waiting for a request. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // A timed-out background fetch (watcher, summaries…) must never surface as a server error or take the engine down.
    const g = globalThis as unknown as { __mgRejections?: boolean };
    if (!g.__mgRejections) {
      g.__mgRejections = true;
      process.on("unhandledRejection", (e) => console.log(`[marigold] background error (ignored): ${e instanceof Error ? e.name + ": " + e.message : String(e)}`));
    }
    await import("./lib/server/agent/tools");
    // Marigold noticing things on its own (calendar, texts, email, reminders…) → pings.
    (await import("./lib/server/agent/watcher")).startWatcher();
  }
}
