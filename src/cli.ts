#!/usr/bin/env bun
import type { QuotaResult } from "./providers/types.js";
import { exitCode, formatStatus, summarize } from "./cli-core.js";
import { reasonOf } from "./log.js";

export interface RunResult {
  output: string;
  code: 0 | 1 | 2 | 3;
}

type Request = (input: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

const PROJECT_STATS_TIMEOUT_MS = 10_000;

async function requestWithTimeout(request: Request, input: string, timeoutMs = PROJECT_STATS_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(input, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const HELP = `llm-quota status [--json]
llm-quota provider <id> [--json]
llm-quota doctor
llm-quota stats

env: LLM_QUOTA_URL (default http://localhost:4747)
exit: 0 healthy, 1 quota <=20%, 2 provider error, 3 server/usage error`;

/**
 * Both counters are best-effort: `stats` is a courtesy command and neither registry
 * being down is a reason to fail it. What it must not do is answer "0", which is a
 * real and very different number — a fresh release legitimately has zero downloads,
 * and printing it for a DNS failure states as fact something never observed.
 */
function unavailable(error: unknown): string {
  return `unavailable (${reasonOf(error)})`;
}

export async function fetchProjectStats(request: Request = fetch): Promise<string> {
  let npmDownloads: string;
  let githubDownloads: string;

  try {
    const npmRes = await requestWithTimeout(request, "https://api.npmjs.org/downloads/point/last-month/llm-quota");
    if (!npmRes.ok) throw new Error(`http_${npmRes.status}`);
    const data = (await npmRes.json()) as { downloads?: number };
    if (typeof data.downloads !== "number") throw new Error("no download count in the response");
    npmDownloads = data.downloads.toString();
  } catch (error) {
    npmDownloads = unavailable(error);
  }

  try {
    const ghRes = await requestWithTimeout(request, "https://api.github.com/repos/SandroHub013/llm-quota/releases");
    if (!ghRes.ok) throw new Error(`http_${ghRes.status}`);
    const releases = (await ghRes.json()) as Array<{ assets?: Array<{ download_count?: number }> }>;
    if (!Array.isArray(releases)) throw new Error("expected an array of releases");
    let total = 0;
    for (const rel of releases) {
      if (Array.isArray(rel.assets)) {
        for (const asset of rel.assets) {
          total += asset.download_count ?? 0;
        }
      }
    }
    githubDownloads = total.toString();
  } catch (error) {
    githubDownloads = unavailable(error);
  }

  return `NPM Downloads (last 30d): ${npmDownloads}\nGitHub Release Downloads: ${githubDownloads}`;
}

export async function run(args: string[], request: Request = fetch): Promise<RunResult> {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { output: HELP, code: 0 };
  }
  const jsonFlags = args.filter((arg) => arg === "--json");
  const unknownFlags = args.filter((arg) => arg.startsWith("-") && arg !== "--json");
  if (jsonFlags.length > 1 || unknownFlags.length) {
    return { output: "usage: llm-quota --help", code: 3 };
  }

  // Operands only: `provider --json codex` must read "codex", not the flag between them.
  const operands = args.filter((arg) => arg !== "--json");
  const command = operands[0] ?? "status";
  if (!["status", "provider", "doctor", "stats"].includes(command)) {
    return { output: "usage: llm-quota --help", code: 3 };
  }
  if (command === "status" && operands.length > 1) {
    return { output: "usage: llm-quota --help", code: 3 };
  }
  if (command === "provider" && operands.length !== 2) {
    return { output: "usage: llm-quota provider <id>", code: 3 };
  }
  if ((command === "doctor" || command === "stats") && (operands.length !== 1 || jsonFlags.length)) {
    return { output: "usage: llm-quota --help", code: 3 };
  }
  if (command === "stats") {
    const statsOutput = await fetchProjectStats(request);
    return { output: statsOutput, code: 0 };
  }
  try {
    const base = process.env.LLM_QUOTA_URL ?? process.env.WEBQUOTA_URL ?? "http://localhost:4747";
    if (command === "doctor") {
      const response = await request(`${base}/api/providers`);
      if (!response.ok) return { output: `server http_${response.status}`, code: 3 };
      const providers = await response.json() as unknown[];
      return { output: `ok ${providers.length} providers`, code: 0 };
    }
    const id = command === "provider" ? operands[1] : undefined;
    const path = id ? `/api/quota/${encodeURIComponent(id)}` : "/api/quota";
    const response = await request(`${base}${path}`);
    if (!response.ok) return { output: `server http_${response.status}`, code: 3 };
    const body = await response.json() as QuotaResult | { providers: QuotaResult[] };
    const summary = summarize("providers" in body ? body.providers : [body]);
    const output = jsonFlags.length ? JSON.stringify(summary) : formatStatus(summary);
    return { output, code: exitCode(summary) };
  } catch (error) {
    return { output: `server offline: ${error instanceof Error ? error.message : String(error)}`, code: 3 };
  }
}

if (import.meta.main) {
  run(process.argv.slice(2))
    .then(({ output, code }) => {
      console.log(output);
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`server offline: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 3;
    });
}
