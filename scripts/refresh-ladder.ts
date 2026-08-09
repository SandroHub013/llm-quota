/**
 * Regenerates the benchmark ladder the /llmquota skill routes on.
 *
 * The ladder used to be a table typed by hand into the skill file. In the twelve
 * days after one such table was written, two flagship models shipped and a third
 * released open weights — a hand-kept snapshot cannot keep up, and a skill that
 * cites stale numbers confidently is worse than one that says "check first".
 *
 * Run: bun run scripts/refresh-ladder.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".agents",
  "skills",
  "llmquota",
  "references",
  "ladder.json",
);

const DEEPSWE_URL = "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json";
const TERMINAL_BENCH_URL = "https://ofhuhcpkvzjlejydnvyd.supabase.co/functions/v1/leaderboard-read";
// Publishable (anon) Supabase key, the one the public leaderboard page itself sends.
const TERMINAL_BENCH_KEY = "sb_publishable_Z-vuQbpvpG-PStjbh4yE0Q_e-d3MTIH";
const LMARENA_URL =
  "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai%2Fleaderboard-dataset"
  + "&config=webdev&split=latest&offset=0&length=25";

const TIMEOUT_MS = 30_000;

export interface LadderConfig {
  model: string;
  effort: string;
  harness: string;
  passAt1: number;
  ciLo: number;
  ciHi: number;
  outputTokens: number;
  costUsd: number;
  peakContextTokens: number | null;
  agentSteps: number | null;
  /** Pareto: some config scores at least as well on strictly fewer output tokens. */
  dominated: boolean;
  dominatedBy?: string;
  /** Confidence interval overlaps the leader's. Inside the band, rank on tokens, not score. */
  topBand: boolean;
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} -> http ${response.status}`);
  return response.json();
}

function label(config: { model: string; effort: string }): string {
  return `${config.model} ${config.effort}`;
}

/**
 * Pareto dominance on the two axes routing actually trades off: quality and the
 * output tokens spent to reach it. Declared on point estimates only — widening
 * it by the confidence interval would mark almost every config dominated by some
 * cheaper near-equal one, which is what `topBand` is for instead.
 */
function markDominated(configs: LadderConfig[]): void {
  for (const config of configs) {
    for (const other of configs) {
      if (other === config) continue;
      const noWorse = other.passAt1 >= config.passAt1 && other.outputTokens <= config.outputTokens;
      const strictlyBetter =
        other.passAt1 > config.passAt1 || other.outputTokens < config.outputTokens;
      if (noWorse && strictlyBetter) {
        config.dominated = true;
        config.dominatedBy = label(other);
        break;
      }
    }
  }
}

async function deepswe() {
  const data = await getJson(DEEPSWE_URL);
  const configs: LadderConfig[] = (data.rows ?? [])
    .filter((row: any) => typeof row.pass_at_1 === "number" && typeof row.median_output_tokens === "number")
    .map((row: any) => ({
      model: row.model,
      effort: row.reasoning_effort ?? "default",
      harness: row.harness ?? "unknown",
      passAt1: round(row.pass_at_1, 4),
      ciLo: round(row.ci_lo, 4),
      ciHi: round(row.ci_hi, 4),
      outputTokens: Math.round(row.median_output_tokens),
      costUsd: round(row.median_cost_usd, 2),
      peakContextTokens: row.median_peak_context_tokens ?? null,
      agentSteps: row.median_agent_steps == null ? null : Math.round(row.median_agent_steps),
      dominated: false,
      topBand: false,
    }))
    .sort((a: LadderConfig, b: LadderConfig) => b.passAt1 - a.passAt1);

  markDominated(configs);
  const leader = configs[0];
  if (leader) for (const config of configs) config.topBand = config.ciHi >= leader.ciLo;

  const effortLadders: Record<string, Array<Pick<LadderConfig, "effort" | "passAt1" | "outputTokens">>> = {};
  for (const config of configs) {
    (effortLadders[config.model] ??= []).push({
      effort: config.effort,
      passAt1: config.passAt1,
      outputTokens: config.outputTokens,
    });
  }
  for (const ladder of Object.values(effortLadders)) ladder.sort((a, b) => a.outputTokens - b.outputTokens);

  return {
    source: {
      url: DEEPSWE_URL,
      version: "v1.1",
      generatedAt: data.generated_at ?? null,
      tasks: data.n_tasks_in_set ?? null,
      unit: data.unit ?? null,
    },
    configs,
    effortLadders,
  };
}

async function terminalBench() {
  const data = await getJson(TERMINAL_BENCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: TERMINAL_BENCH_KEY },
    body: JSON.stringify({
      package: "terminal-bench/terminal-bench-2-1",
      name: "main",
      page: 1,
      page_size: 50,
    }),
  });
  const rows = (data.rows ?? []).map((row: any) => {
    // The board reports output_tokens and cost aggregated over every trial, while
    // DeepSWE reports per-attempt medians. Normalising here keeps the two boards
    // in the same unit, so a reader cannot accidentally compare a total to a median.
    const trials = row.metrics?.n_trials ?? null;
    const perTrial = (value: unknown) =>
      typeof value === "number" && trials ? Math.round(value / trials) : null;
    return {
      rank: row.rank,
      agent: row.metadata?.agent_display?.label ?? null,
      model: row.metadata?.model_display?.label ?? null,
      effort: row.metadata?.reasoning_effort ?? null,
      date: row.metadata?.date ?? null,
      accuracy: row.metrics?.accuracy ?? null,
      trials,
      outputTokensPerTrial: perTrial(row.metrics?.output_tokens),
      costUsdPerTrial: typeof row.metrics?.total_cost_usd === "number" && trials
        ? round(row.metrics.total_cost_usd / trials, 2)
        : null,
      rewardHacks: row.metrics?.reward_hacks ?? null,
    };
  });
  const dates = rows.map((row: any) => row.date).filter(Boolean).sort();
  return {
    source: {
      url: TERMINAL_BENCH_URL,
      package: "terminal-bench/terminal-bench-2-1",
      entries: rows.length,
      newestEntry: dates[dates.length - 1] ?? null,
    },
    rows,
  };
}

async function lmarenaWebdev() {
  const data = await getJson(LMARENA_URL);
  const rows = (data.rows ?? []).map((entry: any) => ({
    rank: entry.row?.rank ?? null,
    model: entry.row?.model_name ?? null,
    organization: entry.row?.organization ?? null,
    rating: entry.row?.rating ?? null,
    votes: entry.row?.vote_count ?? null,
  }));
  const published = data.rows?.[0]?.row?.leaderboard_publish_date ?? null;
  return { source: { url: LMARENA_URL, config: "webdev", publishDate: published }, rows };
}

function round(value: unknown, digits: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

/** One board failing must not throw away the two that answered. */
async function settle<T>(name: string, task: Promise<T>): Promise<T | { error: string }> {
  try {
    return await task;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ${name}: FAILED — ${message}`);
    return { error: message };
  }
}

const [primary, secondary, tiebreak] = await Promise.all([
  settle("deepswe", deepswe()),
  settle("terminal-bench", terminalBench()),
  settle("lmarena-webdev", lmarenaWebdev()),
]);

const ladder = {
  refreshedAt: new Date().toISOString(),
  note:
    "Generated by scripts/refresh-ladder.ts. Do not hand-edit — rerun the script. "
    + "CursorBench is deliberately absent: it publishes no machine-readable export, its token "
    + "column is undefined on the board, and its author is being acquired by the vendor of a "
    + "model it ranks. See references/cursorbench.md.",
  primary,
  secondary,
  tiebreak,
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(ladder, null, 2)}\n`, "utf8");

const configs = "configs" in primary ? primary.configs.length : 0;
const tb = "rows" in secondary ? secondary.rows.length : 0;
const arena = "rows" in tiebreak ? tiebreak.rows.length : 0;
console.log(`ladder written: ${join("references", "ladder.json")}`);
console.log(`  DeepSWE configs: ${configs}`);
console.log(`  Terminal-Bench rows: ${tb}`);
console.log(`  LMArena WebDev rows: ${arena}`);
if (!configs) process.exitCode = 1;
