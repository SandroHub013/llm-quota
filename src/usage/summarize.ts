import { costOf, displayModel, FX_AS_OF, normalizedModel, PRICING_AS_OF, USD_PER_EUR } from "./pricing.js";
import { addRaw, contextReusePctOf, emptyTokens, rawRow, totalOf } from "./rows.js";
import {
  SOURCE_NAMES,
  type DailyUsage,
  type RawUsageRow,
  type TokenUsage,
  type UsageBreakdown,
  type UsageSourceId,
  type UsageSourceStatus,
  type UsageSummary,
} from "./types.js";

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
