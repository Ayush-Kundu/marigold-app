import { timingSafeEqual } from "crypto";

/** True when Marigold runs inside the Mac app (the app starts the engine with a secret). */
export const inApp = () => !!process.env.MARIGOLD_APP_SECRET;

/** Only the Mac app process knows this secret — pages and other programs never see it. */
export function fromApp(req: Request): boolean {
  const want = process.env.MARIGOLD_APP_SECRET;
  const got = req.headers.get("x-marigold-secret") ?? "";
  if (!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
