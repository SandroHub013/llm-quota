#!/usr/bin/env bun
import type { QuotaResult } from "./providers/types.js";
import { exitCode, formatSnapshot, formatStatus, snapshot, summarize } from "./cli-core.js";
import { acquire, release } from "./reservations.js";

/** The slice of /api/usage a router needs: measured cost per (model, effort). */
interface UsageBody {
  generatedAt?: string;
  estimatedCostEur?: number;
  rows?: Array<{
    source: string;
    model: string;
    effort: string;
    agent: string;
    calls: number;
    total: number;
    output: number;
    costEur?: number;
    contextReusePct: number | null;
  }>;
}

/**
 * `calls` counts model turns, not completed tasks, so this is deliberately not
 * presented as cost-per-task. It is the measured half of a routing decision whose
 * other half — what the dispatch was for and whether it was accepted — has to be
 * recorded by whoever dispatched it.
 */
function formatUsage(body: UsageBody, asJson: boolean): string {
  const rows = (body.rows ?? []).map((row) => ({
    source: row.source,
    model: row.model,
    effort: row.effort,
    agent: row.agent,
    calls: row.calls,
    totalTokens: row.total,
    outputTokens: row.output,
    costEur: row.costEur ?? null,
    contextReusePct: row.contextReusePct,
  }));
  if (asJson) {
    return JSON.stringify({
      generatedAt: body.generatedAt ?? null,
      estimatedCostEur: body.estimatedCostEur ?? null,
      costBasis: "api_equivalent",
      rows,
    });
  }
  if (!rows.length) return "no local history";
  const lines = rows
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((row) =>
      `${row.source} ${row.model} ${row.effort} ${row.agent} `
      + `${row.calls} calls ${Math.round(row.totalTokens / 1000)}k tok`
      + (row.costEur == null ? "" : ` ~€${row.costEur.toFixed(2)}`));
  lines.push(`total ~€${(body.estimatedCostEur ?? 0).toFixed(2)} (API-equivalent, not plan debit)`);
  return lines.join("\n");
}

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
llm-quota snapshot [--json]
llm-quota usage [--json]
llm-quota reserve <provider> [--json]
llm-quota release <id>
llm-quota provider <id> [--json]
llm-quota doctor
llm-quota stats

env: LLM_QUOTA_URL (default http://localhost:4747)
exit: 0 healthy, 1 quota <=20%, 2 provider error, 3 server/usage error
exit (reserve): 0 granted, 1 denied`;

export async function fetchProjectStats(request: Request = fetch): Promise<string> {
  let npmDownloads: number | string = "0";
  let githubDownloads: number | string = "0";

  try {
    const npmRes = await requestWithTimeout(request, "https://api.npmjs.org/downloads/point/last-month/llm-quota");
    if (npmRes.ok) {
      const data = (await npmRes.json()) as { downloads?: number };
      if (typeof data.downloads === "number") npmDownloads = data.downloads.toString();
    }
  } catch {}

  try {
    const ghRes = await requestWithTimeout(request, "https://api.github.com/repos/SandroHub013/llm-quota/releases");
    if (ghRes.ok) {
      const releases = (await ghRes.json()) as Array<{ assets?: Array<{ download_count?: number }> }>;
      if (Array.isArray(releases)) {
        let total = 0;
        for (const rel of releases) {
          if (Array.isArray(rel.assets)) {
            for (const asset of rel.assets) {
              total += asset.download_count ?? 0;
            }
          }
        }
        githubDownloads = total.toString();
      }
    }
  } catch {}

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
  const COMMANDS: Record<string, { operands: number; usage: string }> = {
    status: { operands: 1, usage: "usage: llm-quota --help" },
    snapshot: { operands: 1, usage: "usage: llm-quota --help" },
    usage: { operands: 1, usage: "usage: llm-quota --help" },
    doctor: { operands: 1, usage: "usage: llm-quota --help" },
    stats: { operands: 1, usage: "usage: llm-quota --help" },
    provider: { operands: 2, usage: "usage: llm-quota provider <id>" },
    reserve: { operands: 2, usage: "usage: llm-quota reserve <provider>" },
    release: { operands: 2, usage: "usage: llm-quota release <id>" },
  };
  const spec = COMMANDS[command];
  if (!spec) return { output: "usage: llm-quota --help", code: 3 };
  if (operands.length !== spec.operands) return { output: spec.usage, code: 3 };
  // These print one line and take no structured form.
  if ((command === "doctor" || command === "stats" || command === "release") && jsonFlags.length) {
    return { output: "usage: llm-quota --help", code: 3 };
  }
  if (command === "stats") {
    const statsOutput = await fetchProjectStats(request);
    return { output: statsOutput, code: 0 };
  }
  if (command === "release") {
    const released = await release(operands[1]!);
    return { output: released ? "released" : "no such reservation", code: released ? 0 : 1 };
  }
  try {
    const base = process.env.LLM_QUOTA_URL ?? process.env.WEBQUOTA_URL ?? "http://localhost:4747";
    if (command === "doctor") {
      const response = await request(`${base}/api/providers`);
      if (!response.ok) return { output: `server http_${response.status}`, code: 3 };
      const providers = await response.json() as unknown[];
      return { output: `ok ${providers.length} providers`, code: 0 };
    }
    if (command === "usage") {
      const response = await request(`${base}/api/usage`);
      if (!response.ok) return { output: `server http_${response.status}`, code: 3 };
      const body = await response.json() as UsageBody;
      return { output: formatUsage(body, jsonFlags.length > 0), code: 0 };
    }
    if (command === "snapshot" || command === "reserve") {
      const response = await request(`${base}/api/quota`);
      if (!response.ok) return { output: `server http_${response.status}`, code: 3 };
      const { providers } = await response.json() as { providers: QuotaResult[] };
      const snap = snapshot(providers);
      if (command === "snapshot") {
        return {
          output: jsonFlags.length ? JSON.stringify(snap) : formatSnapshot(snap),
          code: exitCode(summarize(providers)),
        };
      }
      const target = snap.providers.find((provider) => provider.id === operands[1]);
      if (!target) return { output: `unknown provider: ${operands[1]}`, code: 3 };
      const result = await acquire(target.id, target.binding?.remaining, {
        note: target.binding?.label,
      });
      const text = result.granted
        ? `granted ${result.id} (${result.held}/${result.slots} slots)`
        : `denied: ${result.reason} (${result.held}/${result.slots} slots)`;
      return {
        output: jsonFlags.length ? JSON.stringify({ ...result, binding: target.binding }) : text,
        code: result.granted ? 0 : 1,
      };
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
