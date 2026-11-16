import { localOnly } from "@/lib/server/agent/guard";
import { catalog } from "@/lib/server/agent/catalog";

/** Background helpers, installers and system plumbing that aren't something a person opens on purpose. */
const HIDDEN = /helper|uninstall|updater|installer|migration|bluetooth file|boot camp|colorsync|directory utility|audio midi|keychain access|screenshot|system information|voiceover|grapher|print center|ticket viewer|feedback|expansion slot|wireless diag|accessibility|setup assistant|database events|screen sharing|remote desktop|archive utility|storage management|about this mac|apple diagnostics/i;

/** GET → every app on this Mac the user would open, for the app dock beside the chat. */
export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const { apps } = await catalog();
  const list = apps
    .filter((a) => a.path && !HIDDEN.test(a.name))
    .map((a) => ({ name: a.name, kind: a.kind, path: a.path as string, ios: a.ios }));
  return Response.json({ apps: list });
}
