/**
 * Client for the Marigold app's built-in browser (electron/browser.cjs). The app starts the
 * engine with MARIGOLD_BROWSER_PORT + MARIGOLD_APP_SECRET; nothing else can drive these tabs.
 */
export const appBrowserAvailable = () => !!process.env.MARIGOLD_BROWSER_PORT && !!process.env.MARIGOLD_APP_SECRET;

export async function mb(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${process.env.MARIGOLD_BROWSER_PORT}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-marigold-secret": process.env.MARIGOLD_APP_SECRET ?? "" },
    body: JSON.stringify({ cmd, ...args }),
    signal: AbortSignal.timeout(45_000),
  }).catch((e) => {
    const code = (e as { cause?: { code?: string } })?.cause?.code;
    throw new Error(code === "ECONNREFUSED" ? "The Marigold Browser isn't reachable. The app was probably restarted. Quit and reopen Marigold." : `Marigold Browser request failed: ${e instanceof Error ? e.message : e}`);
  });
  if (!r.ok) throw new Error(`Marigold Browser didn't answer (${r.status})`);
  const j = (await r.json()) as { error?: string };
  if (j && typeof j === "object" && "error" in j && j.error && cmd !== "open") throw new Error(j.error);
  return j;
}
