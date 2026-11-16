import { execFile } from "child_process";
import { promisify } from "util";

/**
 * Connections: the websites people lean on most with an assistant, reached through their own official APIs with a personal token
 * the user pastes once (kept in the macOS Keychain, never in a file). GitHub, Notion, Linear and Todoist so far.
 * (Services that need a registered app, like Slack or Microsoft 365, come next; they sign in with a button instead of a token.)
 */

const exec = promisify(execFile);
const UA = "Marigold/1.0 (desktop assistant; acts for its user with their own token)";

export type Service = "github" | "notion" | "linear" | "todoist";
export const SERVICES: Record<Service, { label: string; help: string; url: string }> = {
  github: { label: "GitHub", help: "A personal access token with repo access", url: "https://github.com/settings/tokens" },
  notion: { label: "Notion", help: "An internal integration secret (then share your pages with it)", url: "https://www.notion.so/profile/integrations" },
  linear: { label: "Linear", help: "A personal API key", url: "https://linear.app/settings/account/security" },
  todoist: { label: "Todoist", help: "Your API token (Settings → Integrations → Developer)", url: "https://app.todoist.com/app/settings/integrations/developer" },
};
export const isService = (s: unknown): s is Service => typeof s === "string" && s in SERVICES;

const keychain = (s: Service) => ["-s", `Marigold ${SERVICES[s].label} token`, "-a", "marigold"];
const cache = new Map<Service, string | null>();
export async function getToken(s: Service): Promise<string | null> {
  if (cache.has(s)) return cache.get(s) ?? null;
  const t = await exec("security", ["find-generic-password", ...keychain(s), "-w"]).then((r) => r.stdout.trim() || null, () => null);
  cache.set(s, t);
  return t;
}
export async function saveToken(s: Service, token: string | null) {
  if (token) await exec("security", ["add-generic-password", ...keychain(s), "-w", token.trim(), "-U"]);
  else await exec("security", ["delete-generic-password", ...keychain(s)]).catch(() => {});
  cache.delete(s);
}

async function api(url: string, init: RequestInit & { token?: string | null; json?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  const { token, json, headers, ...rest } = init;
  const r = await fetch(url, {
    ...rest, signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": UA, Accept: "application/json", ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: url.includes("linear.app") ? token : `Bearer ${token}` } : {}), ...(headers as Record<string, string> | undefined) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  let body: unknown = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
}
type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" ? (v as J) : {});
const arr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const need = (x: string, what: string) => { if (!x.trim()) throw new Error(`${what} is needed`); return x.trim(); };
const short = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

// ------------------------------------------------------------ check a token and say whose it is
export async function checkToken(svc: Service, token: string): Promise<string> {
  if (svc === "github") { const r = await api("https://api.github.com/user", { token, headers: { "X-GitHub-Api-Version": "2022-11-28" } }); if (r.status !== 200) throw new Error("GitHub didn't accept that token."); return s(obj(r.body).login); }
  if (svc === "notion") { const r = await api("https://api.notion.com/v1/users/me", { token, headers: { "Notion-Version": "2022-06-28" } }); if (r.status !== 200) throw new Error("Notion didn't accept that secret."); return s(obj(r.body).name) || "your workspace"; }
  if (svc === "linear") { const r = await api("https://api.linear.app/graphql", { method: "POST", token, json: { query: "{ viewer { name } }" } }); const n = s(obj(obj(obj(r.body).data).viewer).name); if (!n) throw new Error("Linear didn't accept that key."); return n; }
  const r = await api("https://api.todoist.com/rest/v2/projects", { token }); if (r.status !== 200) throw new Error("Todoist didn't accept that token."); return "your account";
}

async function must(svc: Service): Promise<string> {
  const t = await getToken(svc);
  if (!t) throw new Error(`${SERVICES[svc].label} isn't connected. Tell the user to open Settings → Connections and add their ${SERVICES[svc].label} token (${SERVICES[svc].url}).`);
  return t;
}
const bad = (svc: Service, status: number, body: unknown) => new Error(`${SERVICES[svc].label} answered ${status}: ${short(s(obj(body).message ?? obj(body).error ?? JSON.stringify(body)), 200)}`);

// ------------------------------------------------------------ GitHub
export async function github(action: string, a: { repo?: string; query?: string; number?: number; title?: string; body?: string }): Promise<string> {
  const token = await getToken("github"); // public things can be read without one
  const h = { "X-GitHub-Api-Version": "2022-11-28" };
  const repo = () => { const r = need(a.repo ?? "", "The repository (owner/name)"); if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error("repo must look like owner/name"); return r; };
  switch (action) {
    case "whoami": { const r = await api("https://api.github.com/user", { token: await must("github"), headers: h }); if (r.status !== 200) throw bad("github", r.status, r.body); return `Signed in as ${s(obj(r.body).login)}.`; }
    case "my_repos": {
      const r = await api("https://api.github.com/user/repos?sort=pushed&per_page=20", { token: await must("github"), headers: h });
      if (r.status !== 200) throw bad("github", r.status, r.body);
      return arr(r.body).map((x) => `${s(x.full_name)}${x.private ? " (private)" : ""} — ${short(s(x.description), 90)} · pushed ${s(x.pushed_at).slice(0, 10)}`).join("\n") || "No repositories.";
    }
    case "search_issues": {
      const q = need(a.query ?? "", "A search");
      const r = await api(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=15`, { token, headers: h });
      if (r.status !== 200) throw bad("github", r.status, r.body);
      return arr(obj(r.body).items).map((x) => `#${s(x.number)} ${s(x.title)} [${s(x.state)}] ${s(x.html_url)}`).join("\n") || "Nothing found.";
    }
    case "get_issue": case "get_pr": {
      const n = Number(a.number); if (!n) throw new Error("number is needed");
      const r = await api(`https://api.github.com/repos/${repo()}/${action === "get_pr" ? "pulls" : "issues"}/${n}`, { token, headers: h });
      if (r.status !== 200) throw bad("github", r.status, r.body);
      const x = obj(r.body);
      const c = await api(`https://api.github.com/repos/${repo()}/issues/${n}/comments?per_page=10`, { token, headers: h });
      return `#${n} ${s(x.title)} [${s(x.state)}] by ${s(obj(x.user).login)}\n${short(s(x.body), 1800)}\n${arr(c.body).map((m) => `— ${s(obj(m.user).login)}: ${short(s(m.body), 300)}`).join("\n")}\n${s(x.html_url)}`;
    }
    case "list_prs": {
      const r = await api(`https://api.github.com/repos/${repo()}/pulls?state=open&per_page=15`, { token, headers: h });
      if (r.status !== 200) throw bad("github", r.status, r.body);
      return arr(r.body).map((x) => `#${s(x.number)} ${s(x.title)} by ${s(obj(x.user).login)} ${s(x.html_url)}`).join("\n") || "No open pull requests.";
    }
    case "create_issue": {
      const r = await api(`https://api.github.com/repos/${repo()}/issues`, { method: "POST", token: await must("github"), headers: h, json: { title: need(a.title ?? "", "A title"), body: a.body ?? "" } });
      if (r.status !== 201) throw bad("github", r.status, r.body);
      return `Created issue #${s(obj(r.body).number)}: ${s(obj(r.body).html_url)}`;
    }
    case "comment": {
      const n = Number(a.number); if (!n) throw new Error("number is needed");
      const r = await api(`https://api.github.com/repos/${repo()}/issues/${n}/comments`, { method: "POST", token: await must("github"), headers: h, json: { body: need(a.body ?? "", "The comment") } });
      if (r.status !== 201) throw bad("github", r.status, r.body);
      return `Commented: ${s(obj(r.body).html_url)}`;
    }
  }
  throw new Error(`unknown GitHub action ${action}`);
}

// ------------------------------------------------------------ Notion
const NV = { "Notion-Version": "2022-06-28" };
const plain = (rt: unknown) => arr(rt).map((t) => s(t.plain_text)).join("");
const titleOf = (p: J) => { const props = obj(p.properties); for (const v of Object.values(props)) { const o = obj(v); if (o.type === "title") return plain(o.title); } return s(obj(p).title ? plain(p.title) : "") || "(untitled)"; };
export async function notion(action: string, a: { query?: string; page_id?: string; parent_id?: string; title?: string; text?: string; database_id?: string }): Promise<string> {
  const token = await must("notion");
  const id = (x: string | undefined, what: string) => need(x ?? "", what).replace(/-/g, "").match(/[0-9a-f]{32}/i)?.[0] ?? (() => { throw new Error(`${what} doesn't look like a Notion id`); })();
  switch (action) {
    case "search": {
      const r = await api("https://api.notion.com/v1/search", { method: "POST", token, headers: NV, json: { query: a.query ?? "", page_size: 15 } });
      if (r.status !== 200) throw bad("notion", r.status, r.body);
      return arr(obj(r.body).results).map((x) => `${s(x.object)}: ${titleOf(x)} — id ${s(x.id)} ${s(x.url)}`).join("\n") || "Nothing found (Notion only shows pages that were shared with the integration).";
    }
    case "get_page": {
      const pid = id(a.page_id, "page_id");
      const r = await api(`https://api.notion.com/v1/blocks/${pid}/children?page_size=100`, { token, headers: NV });
      if (r.status !== 200) throw bad("notion", r.status, r.body);
      const lines = arr(obj(r.body).results).map((b) => { const t = s(b.type); const body = obj(b[t]); return `${t.startsWith("heading") ? "# " : t.includes("list") ? "- " : t === "to_do" ? (body.checked ? "[x] " : "[ ] ") : ""}${plain(body.rich_text)}`; }).filter((l) => l.trim());
      return lines.join("\n").slice(0, 8000) || "The page is empty (or has only blocks Marigold can't read as text).";
    }
    case "query_database": {
      const r = await api(`https://api.notion.com/v1/databases/${id(a.database_id, "database_id")}/query`, { method: "POST", token, headers: NV, json: { page_size: 25 } });
      if (r.status !== 200) throw bad("notion", r.status, r.body);
      return arr(obj(r.body).results).map((x) => `${titleOf(x)} — id ${s(x.id)}`).join("\n") || "No rows.";
    }
    case "create_page": {
      const r = await api("https://api.notion.com/v1/pages", { method: "POST", token, headers: NV, json: {
        parent: { page_id: id(a.parent_id, "parent_id") }, properties: { title: { title: [{ text: { content: need(a.title ?? "", "A title").slice(0, 200) } }] } },
        children: (a.text ?? "").split(/\n{2,}/).filter(Boolean).slice(0, 90).map((p) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: p.slice(0, 1900) } }] } })) } });
      if (r.status !== 200) throw bad("notion", r.status, r.body);
      return `Created page: ${s(obj(r.body).url)}`;
    }
    case "append": {
      const r = await api(`https://api.notion.com/v1/blocks/${id(a.page_id, "page_id")}/children`, { method: "PATCH", token, headers: NV, json: {
        children: need(a.text ?? "", "The text").split(/\n{2,}/).filter(Boolean).slice(0, 90).map((p) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: p.slice(0, 1900) } }] } })) } });
      if (r.status !== 200) throw bad("notion", r.status, r.body);
      return "Added to the page.";
    }
  }
  throw new Error(`unknown Notion action ${action}`);
}

// ------------------------------------------------------------ Linear
async function gql(token: string, query: string, variables: J = {}): Promise<J> {
  const r = await api("https://api.linear.app/graphql", { method: "POST", token, json: { query, variables } });
  const errs = arr(obj(r.body).errors);
  if (r.status !== 200 || errs.length) throw new Error(`Linear answered ${r.status}: ${short(s(errs[0]?.message ?? JSON.stringify(r.body)), 200)}`);
  return obj(obj(r.body).data);
}
const issueLine = (x: J) => `${s(x.identifier)} ${s(x.title)} [${s(obj(x.state).name)}]${obj(x.assignee).name ? ` → ${s(obj(x.assignee).name)}` : ""}${x.dueDate ? ` due ${s(x.dueDate)}` : ""} ${s(x.url)}`;
export async function linear(action: string, a: { query?: string; team?: string; title?: string; description?: string }): Promise<string> {
  const token = await must("linear");
  switch (action) {
    case "my_issues": {
      const d = await gql(token, `{ viewer { assignedIssues(first: 30, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title dueDate url state { name } } } } }`);
      return arr(obj(obj(d.viewer).assignedIssues).nodes).map(issueLine).join("\n") || "Nothing assigned to you.";
    }
    case "search_issues": {
      const d = await gql(token, `query($q: String!) { issues(first: 20, filter: { title: { containsIgnoreCase: $q } }) { nodes { identifier title url state { name } assignee { name } } } }`, { q: need(a.query ?? "", "A search") });
      return arr(obj(d.issues).nodes).map(issueLine).join("\n") || "Nothing found.";
    }
    case "create_issue": {
      const teams = arr(obj((await gql(token, `{ teams { nodes { id key name } } }`)).teams).nodes);
      const want = (a.team ?? "").toLowerCase();
      const team = teams.find((t) => s(t.key).toLowerCase() === want || s(t.name).toLowerCase() === want) ?? (teams.length === 1 ? teams[0] : undefined);
      if (!team) throw new Error(`Which team? ${teams.map((t) => `${s(t.name)} (${s(t.key)})`).join(", ")}`);
      const d = await gql(token, `mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { identifier url } } }`, { i: { teamId: team.id, title: need(a.title ?? "", "A title"), description: a.description ?? "" } });
      const i = obj(obj(d.issueCreate).issue);
      return `Created ${s(i.identifier)}: ${s(i.url)}`;
    }
  }
  throw new Error(`unknown Linear action ${action}`);
}

// ------------------------------------------------------------ Todoist
export async function todoist(action: string, a: { query?: string; title?: string; due?: string; task_id?: string }): Promise<string> {
  const token = await must("todoist");
  switch (action) {
    case "list_tasks": {
      const r = await api(`https://api.todoist.com/rest/v2/tasks${a.query ? `?filter=${encodeURIComponent(a.query)}` : ""}`, { token });
      if (r.status !== 200) throw bad("todoist", r.status, r.body);
      return arr(r.body).slice(0, 40).map((t) => `${s(t.content)}${obj(t.due).string ? ` (${s(obj(t.due).string)})` : ""} — id ${s(t.id)}`).join("\n") || "No tasks.";
    }
    case "add_task": {
      const r = await api("https://api.todoist.com/rest/v2/tasks", { method: "POST", token, json: { content: need(a.title ?? "", "The task"), ...(a.due ? { due_string: a.due } : {}) } });
      if (r.status !== 200) throw bad("todoist", r.status, r.body);
      return `Added: ${s(obj(r.body).content)}${obj(obj(r.body).due).string ? ` (${s(obj(obj(r.body).due).string)})` : ""}`;
    }
    case "complete_task": {
      const r = await api(`https://api.todoist.com/rest/v2/tasks/${encodeURIComponent(need(a.task_id ?? "", "task_id"))}/close`, { method: "POST", token });
      if (r.status !== 204) throw bad("todoist", r.status, r.body);
      return "Marked done.";
    }
  }
  throw new Error(`unknown Todoist action ${action}`);
}
