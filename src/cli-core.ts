import type { QuotaMetric, QuotaResult, QuotaStatus } from "./providers/types.js";

export interface ProviderSummary {
  id: string;
  status: QuotaStatus;
  remaining?: number;
  resetAt?: string;
}

export interface QuotaSummary {
  providers: ProviderSummary[];
  worst?: { id: string; remaining: number };
}

function metricRemaining(metric: QuotaMetric): number | undefined {
  if (metric.used == null || !metric.limit) return undefined;
  return Math.max(0, Math.min(100, Math.round(100 - (metric.used / metric.limit) * 100)));
}

function providerSummary(result: QuotaResult): ProviderSummary {
  const metrics = result.metrics
    .map((metric) => ({ metric, remaining: metricRemaining(metric) }))
    .filter((item): item is { metric: QuotaMetric; remaining: number } => item.remaining != null)
    .sort((a, b) => a.remaining - b.remaining);
  const worst = metrics[0];
  return {
    id: result.id,
    status: result.status,
    ...(worst ? { remaining: worst.remaining } : {}),
    ...(worst?.metric.resetAt ? { resetAt: worst.metric.resetAt } : {}),
  };
}

export function summarize(results: QuotaResult[]): QuotaSummary {
  const providers = results.map(providerSummary);
  const measured = providers
    .filter((provider): provider is ProviderSummary & { remaining: number } => provider.remaining != null)
    .sort((a, b) => a.remaining - b.remaining);
  return {
    providers,
    ...(measured[0] ? { worst: { id: measured[0].id, remaining: measured[0].remaining } } : {}),
  };
}

function resetIn(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

export function formatStatus(summary: QuotaSummary, now = new Date()): string {
  const lines = summary.providers.map((provider) => {
    if (provider.remaining == null) return `${provider.id} ${provider.status}`;
    const reset = provider.resetAt ? ` reset ${resetIn(provider.resetAt, now)}` : "";
    const status = provider.status === "ok" ? "" : ` ${provider.status}`;
    return `${provider.id} ${provider.remaining}%${reset}${status}`;
  });
  if (summary.worst) lines.push(`worst ${summary.worst.id} ${summary.worst.remaining}%`);
  return lines.join("\n");
}

const FAILED = new Set<QuotaStatus>(["error", "partial", "unauthenticated", "rate_limited"]);

export function exitCode(summary: QuotaSummary): 0 | 1 | 2 {
  if (summary.providers.some((provider) => FAILED.has(provider.status))) return 2;
  if (summary.worst && summary.worst.remaining <= 20) return 1;
  return 0;
}
