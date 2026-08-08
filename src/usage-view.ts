import type { UsageSummary } from "./usage.js";

/**
 * The usage table filters (source / agent) are shared state, not a browser
 * preference: the dashboard headline, its button and the desktop widget must
 * all read the same figure, so the view lives in the server-side config and
 * every surface derives its total from it.
 */
export interface UsageView {
  source: string;
  agent: string;
}

export const DEFAULT_USAGE_VIEW: UsageView = { source: "all", agent: "all" };

const SOURCES = new Set(["all", "codex", "claude", "opencode", "kimi"]);
const AGENTS = new Set(["all", "main", "subagent"]);

/** Unknown or hand-edited values fall back to "all" rather than breaking the view. */
export function normalizeUsageView(input: unknown): UsageView {
  const candidate = (input ?? {}) as Record<string, unknown>;
  return {
    source: SOURCES.has(String(candidate.source)) ? String(candidate.source) : "all",
    agent: AGENTS.has(String(candidate.agent)) ? String(candidate.agent) : "all",
  };
}

export function usageFiltersActive(view: UsageView): boolean {
  return view.source !== "all" || view.agent !== "all";
}

/**
 * Same math as the dashboard's usageHeadlineTotal(): once the table is narrowed,
 * the figure worth reading is the sum of the visible rows, not the untouched
 * grand total. Rows without a public price carry no figure and contribute zero,
 * exactly like the client-side `rowCost(row) ?? 0`.
 */
export function usageHeadlineCosts(summary: UsageSummary, view: UsageView): { eur: number; usd: number } {
  if (!usageFiltersActive(view)) {
    return { eur: summary.estimatedCostEur, usd: summary.estimatedCostUsd };
  }
  let eur = 0;
  let usd = 0;
  for (const row of summary.rows) {
    if (row.total <= 0) continue;
    if (view.source !== "all" && row.source !== view.source) continue;
    if (view.agent !== "all" && row.agent !== view.agent) continue;
    eur += row.costEur ?? 0;
    usd += row.costUsd ?? 0;
  }
  return { eur, usd };
}
