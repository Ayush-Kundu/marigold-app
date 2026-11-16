#!/usr/bin/env node
// marigold — talk to your Marigold agent from the terminal.
//
//   marigold "organize my Downloads by file type"   one request, then exit
//   marigold                                          interactive session (keeps context)
//
// Uses the same local agent and safety rules as the app. Approvals are asked right
// here (y = once, a = always, n = no). Money actions still need Touch ID in the app.

import readline from "node:readline/promises";
import { stdin, stdout, argv, exit, env } from "node:process";

const BASE = env.MARIGOLD_URL ?? "http://localhost:3000";
const c = { dim: (t) => `\x1b[2m${t}\x1b[0m`, gold: (t) => `\x1b[33m${t}\x1b[0m`, red: (t) => `\x1b[31m${t}\x1b[0m`, green: (t) => `\x1b[32m${t}\x1b[0m`, bold: (t) => `\x1b[1m${t}\x1b[0m` };
// Interactive terminal → ask questions live. Piped input (scripts) → answers are read
// from stdin in order; anything unanswered defaults to "no".
const piped = !stdin.isTTY;
const queued = [];
if (piped) {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  queued.push(...data.split("\n").map((l) => l.trim()).filter(Boolean));
}
const rl = piped ? null : readline.createInterface({ input: stdin, output: stdout });
const question = async (q) => {
  if (!piped) return rl.question(q);
  const a = queued.shift() ?? "n";
  stdout.write(`${q}${a}\n`);
  return a;
};
const chatId = `cli-${Date.now().toString(36)}`;
const history = [];

async function approve(step) {
  if (step.tier === 3) {
    console.log(c.red(`  💳 ${step.title}\n     Money action — approve it with Touch ID in the Marigold app (it's waiting there).`));
    return;
  }
  const why = step.approval?.reason ? c.dim(`\n     ${step.approval.reason}`) : "";
  const opts = step.approval?.rememberable ? "[y]es once / [a]lways / [n]o" : "[y]es / [n]o";
  const ans = (await question(c.gold(`  ? ${step.title}${why}\n    ${opts}: `))).trim().toLowerCase();
  const yes = ans === "y" || ans === "yes" || ans === "a" || ans === "always";
  await fetch(`${BASE}/api/agent/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: step.id, approve: yes, remember: ans.startsWith("a") && !!step.approval?.rememberable }),
  });
}

async function ask(text) {
  history.push({ role: "user", content: text });
  let res;
  try {
    res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, model: "agent", messages: history }),
    });
  } catch {
    console.log(c.red(`Can't reach Marigold at ${BASE}. Start it with: cd ~/Developer/agent-app && npm run dev`));
    exit(1);
  }
  if (!res.ok || !res.body) { console.log(c.red(`Marigold error ${res.status}`)); return; }
  const seen = new Map();
  let reply = "", buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.type === "step") {
        const s = e.step;
        const prev = seen.get(s.id);
        seen.set(s.id, s.status);
        if (s.status === "awaiting" && prev !== "awaiting") await approve(s);
        else if (s.status === "running" && !prev) process.stdout.write(c.dim(`  · ${s.title}\n`));
        else if (s.status === "done") process.stdout.write(c.green(`  ✓ ${s.title}\n`));
        else if (["blocked", "declined", "error"].includes(s.status)) process.stdout.write(c.red(`  ✗ ${s.title}${s.result ? ` — ${String(s.result).slice(0, 160)}` : ""}\n`));
      } else if (e.type === "token") {
        if (!reply) process.stdout.write("\n");
        reply += e.value;
        process.stdout.write(e.value);
      } else if (e.type === "error") {
        console.log(c.red(`\n${e.message}`));
      }
    }
  }
  process.stdout.write("\n\n");
  history.push({ role: "assistant", content: reply });
}

const oneShot = argv.slice(2).join(" ").trim();
if (oneShot) {
  await ask(oneShot);
  rl?.close();
} else if (piped) {
  console.log("Give the request as an argument when piping answers, e.g.  echo y | marigold \"…\"");
} else {
  console.log(c.bold("Marigold") + c.dim("  — ask anything, Ctrl+C or 'exit' to quit\n"));
  for (;;) {
    const q = (await question(c.gold("› "))).trim();
    if (!q) continue;
    if (q === "exit" || q === "quit") break;
    await ask(q);
  }
  rl?.close();
}
