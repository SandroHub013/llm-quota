import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

export type UsageSourceId = "codex" | "claude" | "opencode" | "kimi";
export type AgentKind = "main" | "subagent";

export interface TokenUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Reasoning is a subset of output and must not be added to total tokens. */
  reasoning: number;
  total: number;
}

export interface UsageBreakdown extends TokenUsage {
  source: UsageSourceId;
  sourceName: string;
  model: string;
  effort: string;
  agent: AgentKind;
  calls: number;
  /** Share of input context served from cache; null when no context was recorded. */
  contextReusePct: number | null;
  costUsd?: number;
  costEur?: number;
  costBasis?: "public_list" | "recorded";
}

export interface DailyUsage {
  /** UTC calendar day derived from the timestamp stored by each local CLI. */
  date: string;
  calls: number;
  tokens: TokenUsage;
  contextReusePct: number | null;
  estimatedCostEur: number;
  pricingCoveragePct: number;
  sources: UsageSourceId[];
}

export interface UsageSourceStatus {
  id: UsageSourceId | "gemini";
  name: string;
  status: "ok" | "missing" | "unsupported" | "error";
  files?: number;
  message?: string;
}

export interface UsageSummary {
  estimatedCostEur: number;
  estimatedCostUsd: number;
  currency: "EUR";
  tokens: TokenUsage;
  /** Aggregate share of input context served from cache. */
  contextReusePct: number | null;
  pricedTokens: number;
  pricingCoveragePct: number;
  rows: UsageBreakdown[];
  /** Real per-day activity for the local spend calendar; undated records are excluded. */
  daily: DailyUsage[];
  sources: UsageSourceStatus[];
  unpricedModels: string[];
  generatedAt: string;
  pricing: {
    kind: "api_equivalent";
    asOf: string;
    usdPerEur: number;
    fxAsOf: string;
    note: string;
  };
}

export interface RawUsageRow {
  source: UsageSourceId;
  model: string;
  effort: string;
  agent: AgentKind;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  output: number;
  reasoning: number;
  recordedCostUsd?: number;
  /** Original log timestamp normalized to ISO-8601 when the source exposes one. */
  recordedAt?: string;
}

interface ClaudeMessage {
  id: string;
  row: RawUsageRow;
}

export interface CodexFileUsage {
  sessionId: string;
  rows: RawUsageRow[];
}

interface Price {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  output: number;
}

interface FileCacheEntry<T> {
  size: number;
  mtimeMs: number;
  value: T;
}

export interface UsagePaths {
  codex: string;
  codexArchived?: string;
  claude: string;
  kimi: string;
  opencodeDb: string;
}

const SOURCE_NAMES: Record<UsageSourceId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  kimi: "Kimi Code",
};

// Public API list prices in USD per million tokens, checked 2026-08-02.
// Sources: developers.openai.com/api/docs/models, platform.claude.com/docs/en/about-claude/pricing,
// docs.z.ai/guides/overview/pricing, and platform.kimi.ai/docs/pricing/chat.
// Reasoning tokens are included in output tokens by every supported log format.
const PRICES: Record<string, Price> = {
  "gpt-5.6-sol": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cacheRead: 0.25, cacheWrite: 3.125, output: 15 },
  "gpt-5.6-luna": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 },
  "gpt-5.5": { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30 },

  "claude-fable-5": { input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-4-7": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 },
  // Introductory price through 2026-08-31.
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-sonnet-4-6": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },

  "glm-5.2": { input: 1.4, cacheRead: 0.26, cacheWrite: 1.4, output: 4.4 },
  "glm-5.1": { input: 1.4, cacheRead: 0.26, cacheWrite: 1.4, output: 4.4 },
  "glm-5": { input: 1, cacheRead: 0.2, cacheWrite: 1, output: 3.2 },
  "glm-5-turbo": { input: 1.2, cacheRead: 0.24, cacheWrite: 1.2, output: 4 },
  "glm-4.7": { input: 0.6, cacheRead: 0.11, cacheWrite: 0.6, output: 2.2 },
  "glm-4.5-air": { input: 0.2, cacheRead: 0.03, cacheWrite: 0.2, output: 1.1 },

  "kimi-k3": { input: 3, cacheRead: 0.3, cacheWrite: 3, output: 15 },
  "kimi-k2.7-code": { input: 0.95, cacheRead: 0.19, cacheWrite: 0.95, output: 4 },
  "kimi-k2.7-code-highspeed": { input: 1.9, cacheRead: 0.38, cacheWrite: 1.9, output: 8 },
};

const USD_PER_EUR = 1.1485;
const PRICING_AS_OF = "2026-08-02";
const FX_AS_OF = "2026-07-31";

const codexCache = new Map<string, FileCacheEntry<CodexFileUsage>>();
const claudeCache = new Map<string, FileCacheEntry<ClaudeMessage[]>>();
const kimiCache = new Map<string, FileCacheEntry<RawUsageRow[]>>();

const emptyTokens = (): TokenUsage => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});

const number = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const isoTimestamp = (value: unknown): string | undefined => {
  if (value == null || value === "") return undefined;
  let input: string | number = value as string | number;
  if (typeof input === "string" && /^\d+(?:\.\d+)?$/.test(input)) input = Number(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return undefined;
    // Local stores vary between Unix seconds, milliseconds and microseconds.
    if (input < 100_000_000_000) input *= 1_000;
    else if (input > 100_000_000_000_000) input /= 1_000;
  }
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const recordTimestamp = (record: any): string | undefined =>
  isoTimestamp(record?.timestamp ?? record?.time ?? record?.created_at ?? record?.createdAt);

const totalOf = (row: Pick<RawUsageRow, "input" | "cacheRead" | "cacheWrite" | "output">) =>
  row.input + row.cacheRead + row.cacheWrite + row.output;

const contextReusePctOf = (
  row: Pick<RawUsageRow, "input" | "cacheRead" | "cacheWrite">,
): number | null => {
  const context = row.input + row.cacheRead + row.cacheWrite;
  return context > 0 ? Math.round(row.cacheRead / context * 1_000) / 10 : null;
};

const addRaw = (target: RawUsageRow, source: RawUsageRow) => {
  target.calls += source.calls;
  target.input += source.input;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  if (source.cacheWrite5m != null) {
    target.cacheWrite5m = number(target.cacheWrite5m) + number(source.cacheWrite5m);
  }
  if (source.cacheWrite1h != null) {
    target.cacheWrite1h = number(target.cacheWrite1h) + number(source.cacheWrite1h);
  }
  target.output += source.output;
  target.reasoning += source.reasoning;
  if (source.recordedCostUsd != null) {
    target.recordedCostUsd = number(target.recordedCostUsd) + source.recordedCostUsd;
  }
};

const normalizedModel = (model: string): string => {
  const value = model.toLowerCase().replace(/_/g, "-").replace(/-\d{8}$/, "");
  if (value === "gpt-5.6" || value === "gpt-5.6-sol-pro") return "gpt-5.6-sol";
  if (value.endsWith("/k3") || value === "k3") return "kimi-k3";
  if (value.includes("k2.7") && value.includes("highspeed")) return "kimi-k2.7-code-highspeed";
  if (value.includes("k2.7")) return "kimi-k2.7-code";
  const providerModel = value.split("/").at(-1)!;
  if (PRICES[providerModel]) return providerModel;
  return value;
};

const priceFor = (model: string, effort = ""): Price | undefined => {
  const key = normalizedModel(model);
  if (key.endsWith("-free")) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  if (effort.includes("fast")) {
    if (key === "claude-opus-5" || key === "claude-opus-4-8") {
      return { input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 };
    }
    if (key === "claude-opus-4-7") {
      return { input: 30, cacheRead: 3, cacheWrite: 37.5, cacheWrite1h: 60, output: 150 };
    }
  }
  return PRICES[key];
};

const displayModel = (model: string): string => {
  const key = normalizedModel(model);
  const known: Record<string, string> = {
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.5": "GPT-5.5",
    "claude-fable-5": "Claude Fable 5",
    "claude-opus-5": "Claude Opus 5",
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "glm-5.2": "GLM-5.2",
    "glm-5.1": "GLM-5.1",
    "glm-5": "GLM-5",
    "glm-5-turbo": "GLM-5 Turbo",
    "glm-4.7": "GLM-4.7",
    "glm-4.5-air": "GLM-4.5 Air",
    "kimi-k3": "Kimi K3",
    "kimi-k2.7-code": "Kimi K2.7 Code",
    "kimi-k2.7-code-highspeed": "Kimi K2.7 Code Highspeed",
  };
  return known[key] ?? model;
};

async function* lines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) yield line;
}

async function walk(root: string, name: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(name)) found.push(path);
    }
  }
  return found;
}

async function cachedFile<T>(
  cache: Map<string, FileCacheEntry<T>>,
  path: string,
  read: () => Promise<T>,
): Promise<T> {
  const info = await stat(path);
  const cached = cache.get(path);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.value;
  const value = await read();
  cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, value });
  return value;
}

const rawRow = (
  source: UsageSourceId,
  model: string,
  effort: string,
  agent: AgentKind,
): RawUsageRow => ({
  source,
  model: model || "unknown",
  effort: effort || "default",
  agent,
  calls: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});

function codexAgent(payload: any): AgentKind {
  return payload?.thread_source === "subagent" || payload?.source?.subagent ? "subagent" : "main";
}

export function parseCodexRecords(records: string[], fallbackId = "session"): CodexFileUsage {
  let sessionId = fallbackId;
  let model = "unknown";
  let effort = "default";
  let agent: AgentKind = "main";
  let previous: Record<string, number> | undefined;
  const grouped = new Map<string, RawUsageRow>();

  for (const line of records) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) {
      continue;
    }
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "session_meta") {
      sessionId = String(record.payload?.session_id ?? record.payload?.id ?? sessionId);
      agent = codexAgent(record.payload);
      continue;
    }
    if (record.type === "turn_context") {
      model = String(record.payload?.model ?? model);
      effort = String(record.payload?.effort ?? effort);
      continue;
    }
    if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;

    const usage = record.payload?.info?.total_token_usage;
    if (!usage) continue;
    const current: Record<string, number> = {
      input_tokens: number(usage.input_tokens),
      cached_input_tokens: number(usage.cached_input_tokens),
      cache_write_input_tokens: number(usage.cache_write_input_tokens),
      output_tokens: number(usage.output_tokens),
      reasoning_output_tokens: number(usage.reasoning_output_tokens),
    };
    const reset = previous && Object.keys(current).some((key) => current[key]! < number(previous?.[key]));
    const delta = Object.fromEntries(
      Object.entries(current).map(([key, value]) => [key, Math.max(0, value - (reset ? 0 : number(previous?.[key])))]),
    );
    previous = current;
    if (Object.values(delta).every((value) => value === 0)) continue;

    const recordedAt = recordTimestamp(record);
    const key = `${model}\u0000${effort}\u0000${agent}\u0000${recordedAt?.slice(0, 10) ?? "undated"}`;
    const row = grouped.get(key) ?? rawRow("codex", model, effort, agent);
    if (recordedAt && !row.recordedAt) row.recordedAt = recordedAt;
    const cacheRead = number(delta.cached_input_tokens);
    const cacheWrite = number(delta.cache_write_input_tokens);
    row.calls += 1;
    row.cacheRead += cacheRead;
    row.cacheWrite += cacheWrite;
    row.input += Math.max(0, number(delta.input_tokens) - cacheRead - cacheWrite);
    row.output += number(delta.output_tokens);
    row.reasoning += number(delta.reasoning_output_tokens);
    grouped.set(key, row);
  }
  return { sessionId, rows: [...grouped.values()] };
}

async function scanCodex(path: string): Promise<CodexFileUsage> {
  const selected: string[] = [];
  for await (const line of lines(path)) {
    if (line.includes('"session_meta"') || line.includes('"turn_context"') || line.includes('"token_count"')) {
      selected.push(line);
    }
  }
  return parseCodexRecords(selected, basename(path));
}

export function parseClaudeRecords(records: string[], subagentFile = false): ClaudeMessage[] {
  const messages = new Map<string, RawUsageRow>();
  for (const line of records) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = record.message?.usage;
    const id = record.message?.id;
    if (record.type !== "assistant" || !usage || !id) continue;

    const cache5m = number(usage.cache_creation?.ephemeral_5m_input_tokens);
    const cache1h = number(usage.cache_creation?.ephemeral_1h_input_tokens);
    const cacheWrite = number(usage.cache_creation_input_tokens);
    const speed = usage.speed === "fast" ? " · fast" : "";
    const row = rawRow(
      "claude",
      String(record.message?.model ?? "unknown"),
      String(record.effort ?? "default") + speed,
      record.isSidechain || record.agentId || subagentFile ? "subagent" : "main",
    );
    row.calls = 1;
    row.input = number(usage.input_tokens);
    row.cacheRead = number(usage.cache_read_input_tokens);
    row.cacheWrite = cacheWrite;
    row.cacheWrite5m = cache5m || Math.max(0, cacheWrite - cache1h);
    row.cacheWrite1h = cache1h;
    row.output = number(usage.output_tokens);
    row.reasoning = number(usage.reasoning_tokens ?? usage.thinking_tokens);
    const recordedAt = recordTimestamp(record);
    if (recordedAt) row.recordedAt = recordedAt;

    const old = messages.get(String(id));
    if (!old || totalOf(row) >= totalOf(old)) messages.set(String(id), row);
  }
  return [...messages].map(([id, row]) => ({ id, row }));
}

async function scanClaude(path: string): Promise<ClaudeMessage[]> {
  const selected: string[] = [];
  for await (const line of lines(path)) {
    if (line.includes('"assistant"') && line.includes('"usage"')) selected.push(line);
  }
  return parseClaudeRecords(selected, /[\\/]subagents[\\/]/i.test(path));
}

export function parseKimiRecords(records: string[], agent: AgentKind = "main"): RawUsageRow[] {
  let model = "unknown";
  let effort = "default";
  const rows: RawUsageRow[] = [];
  for (const line of records) {
    if (!line.includes('"llm.request"') && !line.includes('"usage.record"')) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "llm.request") {
      model = String(record.modelAlias ?? record.model ?? model);
      effort = String(record.thinkingEffort ?? effort);
      continue;
    }
    if (record.type !== "usage.record" || !record.usage) continue;
    const usage = record.usage;
    const row = rawRow("kimi", String(record.model ?? model), effort, agent);
    row.calls = 1;
    row.input = number(usage.inputOther ?? usage.input);
    row.cacheRead = number(usage.inputCacheRead);
    row.cacheWrite = number(usage.inputCacheCreation);
    row.output = number(usage.output);
    row.reasoning = number(usage.outputReasoning ?? usage.reasoning);
    const recordedAt = recordTimestamp(record);
    if (recordedAt) row.recordedAt = recordedAt;
    rows.push(row);
  }
  return rows;
}

async function scanKimi(path: string): Promise<RawUsageRow[]> {
  const selected: string[] = [];
  for await (const line of lines(path)) {
    if (line.includes('"llm.request"') || line.includes('"usage.record"')) selected.push(line);
  }
  const agent = /[\\/]agents[\\/](?:main)[\\/]/i.test(path) ? "main" : "subagent";
  return parseKimiRecords(selected, agent);
}

async function scanOpenCode(path: string): Promise<RawUsageRow[]> {
  if (!existsSync(path) || typeof Bun === "undefined") return [];
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { readonly: true });
  try {
    const sessions = db.query(`
      SELECT parent_id, model, cost, tokens_input, tokens_output, tokens_reasoning,
             tokens_cache_read, tokens_cache_write, time_created
      FROM session
    `).all() as Record<string, unknown>[];
    return sessions.map((session) => {
      let metadata: any = {};
      try {
        metadata = JSON.parse(String(session.model ?? "{}"));
      } catch {}
      const row = rawRow(
        "opencode",
        String(metadata.id ?? "unknown"),
        String(metadata.variant ?? "default"),
        session.parent_id ? "subagent" : "main",
      );
      row.calls = 1;
      row.input = number(session.tokens_input);
      row.cacheRead = number(session.tokens_cache_read);
      row.cacheWrite = number(session.tokens_cache_write);
      row.reasoning = number(session.tokens_reasoning);
      // OpenCode stores visible output and reasoning separately. Normalize output
      // to the other sources, where reasoning is a subset of billed output.
      row.output = number(session.tokens_output) + row.reasoning;
      if (number(session.cost) > 0) row.recordedCostUsd = number(session.cost);
      const recordedAt = isoTimestamp(session.time_created);
      if (recordedAt) row.recordedAt = recordedAt;
      return row;
    });
  } finally {
    db.close();
  }
}

function costOf(row: RawUsageRow): { usd?: number; basis?: "public_list" | "recorded" } {
  const price = priceFor(row.model, row.effort);
  if (price) {
    const cache1h = number(row.cacheWrite1h);
    const cache5m = row.cacheWrite5m == null
      ? Math.max(0, row.cacheWrite - cache1h)
      : number(row.cacheWrite5m);
    const usd = (
      row.input * price.input +
      row.cacheRead * price.cacheRead +
      cache5m * price.cacheWrite +
      cache1h * (price.cacheWrite1h ?? price.cacheWrite) +
      row.output * price.output
    ) / 1_000_000;
    return { usd, basis: "public_list" };
  }
  if (row.recordedCostUsd != null) return { usd: row.recordedCostUsd, basis: "recorded" };
  return {};
}

function summarizeDailyUsage(raw: RawUsageRow[]): DailyUsage[] {
  const grouped = new Map<string, {
    calls: number;
    tokens: TokenUsage;
    pricedTokens: number;
    estimatedCostUsd: number;
    sources: Set<UsageSourceId>;
  }>();

  for (const row of raw) {
    const date = row.recordedAt?.slice(0, 10);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const day = grouped.get(date) ?? {
      calls: 0,
      tokens: emptyTokens(),
      pricedTokens: 0,
      estimatedCostUsd: 0,
      sources: new Set<UsageSourceId>(),
    };
    const total = totalOf(row);
    day.calls += row.calls;
    day.tokens.input += row.input;
    day.tokens.cacheRead += row.cacheRead;
    day.tokens.cacheWrite += row.cacheWrite;
    day.tokens.output += row.output;
    day.tokens.reasoning += row.reasoning;
    day.tokens.total += total;
    day.sources.add(row.source);
    const cost = costOf(row);
    if (cost.usd != null) {
      day.pricedTokens += total;
      day.estimatedCostUsd += cost.usd;
    }
    grouped.set(date, day);
  }

  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({
    date,
    calls: day.calls,
    tokens: day.tokens,
    contextReusePct: contextReusePctOf(day.tokens),
    estimatedCostEur: day.estimatedCostUsd / USD_PER_EUR,
    pricingCoveragePct: day.tokens.total
      ? Math.round(day.pricedTokens / day.tokens.total * 1000) / 10
      : 0,
    sources: [...day.sources].sort(),
  }));
}

export function summarizeUsageRows(
  raw: RawUsageRow[],
  sources: UsageSourceStatus[] = [],
): UsageSummary {
  const grouped = new Map<string, RawUsageRow>();
  for (const source of raw) {
    const key = [source.source, normalizedModel(source.model), source.effort, source.agent].join("\u0000");
    const row = grouped.get(key) ?? rawRow(source.source, normalizedModel(source.model), source.effort, source.agent);
    addRaw(row, source);
    grouped.set(key, row);
  }

  const totals = emptyTokens();
  let pricedTokens = 0;
  let estimatedCostUsd = 0;
  const unpriced = new Set<string>();
  const rows: UsageBreakdown[] = [];

  for (const rawRow of grouped.values()) {
    const total = totalOf(rawRow);
    totals.input += rawRow.input;
    totals.cacheRead += rawRow.cacheRead;
    totals.cacheWrite += rawRow.cacheWrite;
    totals.output += rawRow.output;
    totals.reasoning += rawRow.reasoning;
    totals.total += total;

    const cost = costOf(rawRow);
    if (cost.usd != null) {
      pricedTokens += total;
      estimatedCostUsd += cost.usd;
    } else if (total > 0) {
      unpriced.add(displayModel(rawRow.model));
    }
    rows.push({
      source: rawRow.source,
      sourceName: SOURCE_NAMES[rawRow.source],
      model: displayModel(rawRow.model),
      effort: rawRow.effort,
      agent: rawRow.agent,
      calls: rawRow.calls,
      input: rawRow.input,
      cacheRead: rawRow.cacheRead,
      cacheWrite: rawRow.cacheWrite,
      output: rawRow.output,
      reasoning: rawRow.reasoning,
      total,
      contextReusePct: contextReusePctOf(rawRow),
      ...(cost.usd == null ? {} : {
        costUsd: cost.usd,
        costEur: cost.usd / USD_PER_EUR,
        costBasis: cost.basis,
      }),
    });
  }

  rows.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.total - a.total);
  return {
    estimatedCostEur: estimatedCostUsd / USD_PER_EUR,
    estimatedCostUsd,
    currency: "EUR",
    tokens: totals,
    contextReusePct: contextReusePctOf(totals),
    pricedTokens,
    pricingCoveragePct: totals.total ? Math.round(pricedTokens / totals.total * 1000) / 10 : 0,
    rows,
    daily: summarizeDailyUsage(raw),
    sources,
    unpricedModels: [...unpriced].sort(),
    generatedAt: new Date().toISOString(),
    pricing: {
      kind: "api_equivalent",
      asOf: PRICING_AS_OF,
      usdPerEur: USD_PER_EUR,
      fxAsOf: FX_AS_OF,
      note: "Estimated API-equivalent value, not the amount charged by subscription plans.",
    },
  };
}

const defaultPaths = (): UsagePaths => {
  const home = homedir();
  return {
    codex: join(home, ".codex", "sessions"),
    codexArchived: join(home, ".codex", "archived_sessions"),
    claude: join(home, ".claude", "projects"),
    kimi: join(home, ".kimi-code", "sessions"),
    opencodeDb: join(home, ".local", "share", "opencode", "opencode.db"),
  };
};

export async function collectUsage(paths: UsagePaths = defaultPaths()): Promise<UsageSummary> {
  const raw: RawUsageRow[] = [];
  const sources: UsageSourceStatus[] = [];

  try {
    const files = [
      ...await walk(paths.codex, ".jsonl"),
      ...(paths.codexArchived ? await walk(paths.codexArchived, ".jsonl") : []),
    ];
    const sessions = new Map<string, CodexFileUsage>();
    for (const file of files) {
      const usage = await cachedFile(codexCache, file, () => scanCodex(file));
      const current = sessions.get(usage.sessionId);
      const tokens = usage.rows.reduce((sum, row) => sum + totalOf(row), 0);
      const currentTokens = current?.rows.reduce((sum, row) => sum + totalOf(row), 0) ?? -1;
      if (!current || tokens >= currentTokens) sessions.set(usage.sessionId, usage);
    }
    for (const session of sessions.values()) raw.push(...session.rows);
    sources.push({
      id: "codex",
      name: SOURCE_NAMES.codex,
      status: files.length ? "ok" : "missing",
      files: files.length,
    });
  } catch {
    sources.push({ id: "codex", name: SOURCE_NAMES.codex, status: "error" });
  }

  try {
    const files = await walk(paths.claude, ".jsonl");
    const messages = new Map<string, RawUsageRow>();
    for (const file of files) {
      const records = await cachedFile(claudeCache, file, () => scanClaude(file));
      for (const { id, row } of records) {
        const current = messages.get(id);
        const hasMoreTokens = !current || totalOf(row) > totalOf(current);
        const isCanonicalSubagent = current && totalOf(row) === totalOf(current) &&
          current.agent === "main" && row.agent === "subagent";
        if (hasMoreTokens || isCanonicalSubagent) messages.set(id, row);
      }
    }
    raw.push(...messages.values());
    sources.push({
      id: "claude",
      name: SOURCE_NAMES.claude,
      status: files.length ? "ok" : "missing",
      files: files.length,
    });
  } catch {
    sources.push({ id: "claude", name: SOURCE_NAMES.claude, status: "error" });
  }

  try {
    const files = await walk(paths.kimi, "wire.jsonl");
    for (const file of files) raw.push(...await cachedFile(kimiCache, file, () => scanKimi(file)));
    sources.push({
      id: "kimi",
      name: SOURCE_NAMES.kimi,
      status: files.length ? "ok" : "missing",
      files: files.length,
    });
  } catch {
    sources.push({ id: "kimi", name: SOURCE_NAMES.kimi, status: "error" });
  }

  try {
    const rows = await scanOpenCode(paths.opencodeDb);
    raw.push(...rows);
    sources.push({
      id: "opencode",
      name: SOURCE_NAMES.opencode,
      status: existsSync(paths.opencodeDb) ? "ok" : "missing",
      files: existsSync(paths.opencodeDb) ? 1 : 0,
    });
  } catch {
    sources.push({ id: "opencode", name: SOURCE_NAMES.opencode, status: "error" });
  }

  sources.push({
    id: "gemini",
    name: "Gemini",
    status: "unsupported",
    message: "The local CLI history does not expose reliable token counters.",
  });
  return summarizeUsageRows(raw, sources);
}
