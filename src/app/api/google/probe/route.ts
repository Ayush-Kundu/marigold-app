import { localOnly } from "@/lib/server/agent/guard";
import { connectedAccounts, gapi, oauthConfig } from "@/lib/server/agent/google";

/**
 * GET → which Google APIs are switched on in Marigold's Google Cloud project (one cheap call each).
 * An API that's off answers 403 "has not been used / is disabled" — everything else counts as on.
 */
const APIS: { name: string; service: string; url: string }[] = [
  { name: "Gmail", service: "gmail.googleapis.com", url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" },
  { name: "Calendar", service: "calendar-json.googleapis.com", url: "https://www.googleapis.com/calendar/v3/calendars/primary" },
  { name: "Drive", service: "drive.googleapis.com", url: "https://www.googleapis.com/drive/v3/about?fields=user" },
  { name: "Docs", service: "docs.googleapis.com", url: "https://docs.googleapis.com/v1/documents/probe" },
  { name: "Sheets", service: "sheets.googleapis.com", url: "https://sheets.googleapis.com/v4/spreadsheets/probe" },
  { name: "Slides", service: "slides.googleapis.com", url: "https://slides.googleapis.com/v1/presentations/probe" },
  { name: "Tasks", service: "tasks.googleapis.com", url: "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1" },
  { name: "Contacts (People)", service: "people.googleapis.com", url: "https://people.googleapis.com/v1/people/me?personFields=names" },
];

export async function GET(req: Request) {
  const blocked = localOnly(req);
  if (blocked) return blocked;
  const cfg = await oauthConfig();
  const acct = (await connectedAccounts())[0];
  if (!cfg || !acct) return Response.json({ error: "Connect a Google account first." }, { status: 409 });
  const project = cfg.clientId.split("-")[0];
  const results = await Promise.all(APIS.map(async (a) => {
    try { await gapi(acct.email, a.url); return { name: a.name, on: true }; }
    catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      const off = /has not been used|SERVICE_DISABLED|is disabled|not enabled/i.test(m);
      return { name: a.name, on: !off, ...(off ? { enableUrl: `https://console.developers.google.com/apis/api/${a.service}/overview?project=${project}` } : {}) };
    }
  }));
  return Response.json({ project, account: acct.email, results });
}
