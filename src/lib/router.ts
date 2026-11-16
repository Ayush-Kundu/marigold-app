import type { ModelId } from "./types";

/**
 * Lightweight keyword/intent router.
 *
 * Code / file / dev / terminal intent → Qwen 2.5 Coder.
 * Everything else (writing, email, web, general) → Llama 3.1.
 * A later version can swap this for an LLM-based intent classifier.
 */

// Strong signals that the user wants coding / file work.
const CODE_SIGNALS: RegExp[] = [
  /```/, // a code block
  /\b(code|coding|program|programming|script|scripts|function|functions|class|method)\b/,
  /\b(bug|debug|debugging|stack ?trace|traceback|exception|compile|compiler|lint)\b/,
  /\b(refactor|rewrite this code|optimi[sz]e this|unit test|regex|regexp)\b/,
  /\b(python|javascript|typescript|java|rust|golang|c\+\+|c#|ruby|php|swift|kotlin|bash|shell|sql)\b/,
  /\b(react|next\.?js|node|npm|yarn|pnpm|vite|webpack|docker|kubernetes|git|github|repo|repository)\b/,
  // File & folder management (a core Qwen use case).
  /\b(folder|directory|subdirectory|filesystem|file ?path)\b/,
  /\b(rename|renam\w+|move|moving|copy|copying|delete|deleting|organi[sz]e|duplicate|compress|unzip|extract) .{0,24}\b(file|files|folder|photo|photos|document|documents|screenshot|screenshots)\b/,
  /\.(js|ts|tsx|jsx|py|go|rs|java|rb|php|sh|json|ya?ml|toml|sql|txt|md|csv|pdf|png|jpe?g|docx?|xlsx?|zip)\b/,
  /\b(api endpoint|async|await|variable|array|object|loop|parameter|argument|syntax|runtime error)\b/,
  /\b(terminal|command ?line|cli|shell command|run this command)\b/,
];

export interface RouteResult {
  model: ModelId;
  reason: string;
}

export function routeModel(prompt: string): RouteResult {
  const text = prompt.toLowerCase();
  const hit = CODE_SIGNALS.find((re) => re.test(text) || re.test(prompt));
  if (hit) {
    return { model: "qwen", reason: "detected code/file intent" };
  }
  return { model: "llama", reason: "general / assistant task" };
}
