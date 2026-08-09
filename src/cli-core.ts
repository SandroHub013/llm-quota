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

export interface WindowSnapshot {
  label: string;
  remaining: number;
  resetAt?: string;
}

export interface ProviderSnapshot {
  id: string;
  name: string;
  status: QuotaStatus;
  source?: string;
  plan?: string;
  windows: WindowSnapshot[];
  /** The window that actually limits the next dispatch — the one admission control reads. */
  binding?: WindowSnapshot;
}

/**
 * Every window, not just the tightest one.
 *
 * `summarize` collapses a provider to its worst metric, which is the right
 * answer for "may I dispatch now" and the wrong one for everything else. Claude
 * carries a 5-hour window and a weekly one; Gemini's buckets are separate pools,
 * so a drained third-party bucket makes the provider-wide minimum reject a
 * Gemini bucket that is full and is the one a vision task needs. Planning also
 * needs to know which window binds *after* the next reset, and the minimum
 * cannot say.
 *
 * This is additive on purpose: `status --json` is a released contract and keeps
 * emitting exactly what it always did.
 */
export function snapshot(results: QuotaResult[], now = new Date()): {
  generatedAt: string;
  providers: ProviderSnapshot[];
} {
  const providers = results.map((result) => {
    const windows = result.metrics
      .map((metric) => {
        const remaining = metricRemaining(metric);
        if (remaining == null) return undefined;
        return {
          label: metric.label,
          remaining,
          ...(metric.resetAt ? { resetAt: metric.resetAt } : {}),
        } satisfies WindowSnapshot;
      })
      .filter((window): window is WindowSnapshot => window != null);
    const binding = [...windows].sort((a, b) => a.remaining - b.remaining)[0];
    return {
      id: result.id,
      name: result.name,
      status: result.status,
      ...(result.sourceKind ? { source: result.sourceKind } : {}),
      ...(result.plan ? { plan: result.plan } : {}),
      windows,
      ...(binding ? { binding } : {}),
    } satisfies ProviderSnapshot;
  });
  return { generatedAt: now.toISOString(), providers };
}

export function formatSnapshot(
  snap: { providers: ProviderSnapshot[] },
  now = new Date(),
): string {
  const lines: string[] = [];
  for (const provider of snap.providers) {
    lines.push(`${provider.id} ${provider.status}${provider.plan ? ` plan:${provider.plan}` : ""}`);
    if (!provider.windows.length) {
      lines.push("  no measurable window");
      continue;
    }
    for (const window of provider.windows) {
      const reset = window.resetAt ? ` reset ${resetIn(window.resetAt, now)}` : "";
      const binds = window === provider.binding ? "  <- binding" : "";
      lines.push(`  ${window.label}: ${window.remaining}% left${reset}${binds}`);
    }
  }
  return lines.join("\n");
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
