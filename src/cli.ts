#!/usr/bin/env bun
import type { QuotaResult } from "./providers/types.js";
import { exitCode, formatStatus, summarize } from "./cli-core.js";

export interface RunResult {
  output: string;
  code: 0 | 1 | 2 | 3;
}

type Request = (input: string | URL | globalThis.Request) => Promise<Response>;

const HELP = `llm-quota status [--json]
llm-quota provider <id> [--json]
llm-quota doctor

env: LLM_QUOTA_URL (default http://localhost:4747)
exit: 0 healthy, 1 quota <=20%, 2 provider error, 3 server/usage error`;

export async function run(args: string[], request: Request = fetch): Promise<RunResult> {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    return { output: HELP, code: 0 };
  }
  const command = args.find((arg) => !arg.startsWith("-")) ?? "status";
  if (!["status", "provider", "doctor"].includes(command)) {
    return { output: "usage: llm-quota --help", code: 3 };
  }
  if (command === "provider" && !args[args.indexOf(command) + 1]) {
    return { output: "usage: llm-quota provider <id>", code: 3 };
  }
  try {
    const base = process.env.LLM_QUOTA_URL ?? process.env.WEBQUOTA_URL ?? "http://localhost:4747";
    if (command === "doctor") {
      const response = await request(`${base}/api/providers`);
      if (!response.ok) return { output: `server http_${response.status}`, code: 3 };
      const providers = await response.json() as unknown[];
      return { output: `ok ${providers.length} providers`, code: 0 };
    }
    const id = command === "provider" ? args[args.indexOf(command) + 1] : undefined;
    const path = id ? `/api/quota/${encodeURIComponent(id)}` : "/api/quota";
    const response = await request(`${base}${path}`);
    if (!response.ok) return { output: `server http_${response.status}`, code: 3 };
    const body = await response.json() as QuotaResult | { providers: QuotaResult[] };
    const summary = summarize("providers" in body ? body.providers : [body]);
    const output = args.includes("--json") ? JSON.stringify(summary) : formatStatus(summary);
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
