export type UsageSourceId = "codex" | "claude" | "opencode" | "kimi" | "pi" | "prime" | "nikcli";
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
  id: UsageSourceId | "gemini" | "hermes";
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

export interface CodexFileUsage {
  sessionId: string;
  rows: RawUsageRow[];
}

export interface UsagePaths {
  codex: string;
  codexArchived?: string;
  claude: string;
  kimi: string;
  opencodeDb: string;
  pi: string;
  prime: string;
  /** Prime keeps delegated subagent transcripts outside its session directory. */
  primeArtifacts?: string;
  nikcliDb: string;
}

export const SOURCE_NAMES: Record<UsageSourceId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  kimi: "Kimi Code",
  pi: "pi",
  prime: "Prime Agent",
  nikcli: "NikCLI",
};

/** Every ledger source, so the shared view filter cannot drift from the scanner. */
export const USAGE_SOURCE_IDS = Object.keys(SOURCE_NAMES) as UsageSourceId[];
