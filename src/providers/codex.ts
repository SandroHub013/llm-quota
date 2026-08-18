import type { Provider, QuotaMetric, QuotaResult } from "./types.js";
import { readCodexRateLimits } from "../codex-app-server.js";
import { nowIso } from "./util.js";

const CONSOLE = "https://chatgpt.com/#settings";

export const codex: Provider = {
  id: "codex",
  name: "Codex (ChatGPT)",
  consoleUrl: CONSOLE,

  async fetch(): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "codex",
      name: "Codex (ChatGPT)",
      status: "error",
      consoleUrl: CONSOLE,
      sourceKind: "official_ipc",
      sourceLabel: "Codex app-server",
      metrics: [],
      updatedAt: nowIso(),
    };

    try {
      const response = await readCodexRateLimits();
      const metrics = parseRateLimits(response.rateLimits);
      const plan = readPlan(response.rateLimits);
      if (metrics.length) {
        const exhausted = metrics.some((metric) => (metric.used ?? 0) >= 100);
        return {
          ...base,
          status: exhausted ? "rate_limited" : "ok",
          plan,
          authSource: "Codex app-server",
          sourceUpdatedAt: nowIso(),
          metrics,
          message: exhausted ? "Codex reports an exhausted quota window. Waiting for its official reset." : undefined,
        };
      }
      return {
        ...base,
        status: "partial",
        plan,
        authSource: "Codex app-server",
        message: "Codex is connected, but it returned no active ChatGPT quota windows.",
      };
    } catch (error) {
      const detail = String((error as Error | undefined)?.message ?? error);
      const auth = /login|auth|credential|unauthorized/i.test(detail);
      return {
        ...base,
        status: auth ? "unauthenticated" : "partial",
        message: failureMessage(detail, auth),
      };
    }
  },
};

/**
 * Turn what went wrong into what to do about it.
 *
 * The three cases are different problems: Codex is not installed, Codex is installed
 * and nobody is logged in, or Codex answered with something else. Only the last one is
 * worth showing the raw detail for — the other two have an instruction instead.
 */
function failureMessage(detail: string, auth: boolean): string {
  if (/not recognized|not found|ENOENT|unavailable/i.test(detail)) {
    return "Codex CLI was not found. Install Codex and run `codex login`.";
  }
  if (auth) return "Codex app-server needs a ChatGPT login. Run `codex login`.";
  return `Codex app-server is temporarily unavailable (${safeDetail(detail)}).`;
}

/**
 * The `account/rateLimits/read` reply, as far as this reads it. Every leaf is `unknown`
 * because Codex owns the format: the readers below coerce, and a field that changes
 * type becomes a missing metric rather than a thrown error on the dashboard.
 */
interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface CodexBucket {
  limitName?: unknown;
  limitId?: unknown;
  planType?: unknown;
  primary?: CodexWindow;
  secondary?: CodexWindow;
}

export interface CodexRateLimits {
  planType?: unknown;
  rateLimits?: CodexBucket;
  rateLimitsByLimitId?: Record<string, CodexBucket | null>;
}

/** Parse the stable account/rateLimits/read response. */
export function parseRateLimits(body: unknown): QuotaMetric[] {
  const payload = (body ?? undefined) as CodexRateLimits | undefined;
  const byId = payload?.rateLimitsByLimitId;
  const buckets: CodexBucket[] = byId && typeof byId === "object"
    ? Object.values(byId).filter((bucket): bucket is CodexBucket => Boolean(bucket))
    : payload?.rateLimits
      ? [payload.rateLimits]
      : [];
  const multiple = buckets.length > 1;
  const metrics: QuotaMetric[] = [];

  for (const bucket of buckets) {
    const prefix = multiple ? `${bucket.limitName ?? bucket.limitId ?? "Codex"} \u00b7 ` : "";
    for (const window of [bucket.primary, bucket.secondary]) {
      const used = number(window?.usedPercent);
      // A bucket Codex left out is not a window with no usage; it is no window.
      if (window == null || used == null) continue;
      metrics.push({
        label: `${prefix}${windowLabel(number(window.windowDurationMins))}`,
        used: Math.max(0, Math.min(100, used)),
        limit: 100,
        unit: "percent",
        resetAt: epochIso(window.resetsAt),
      });
    }
  }
  return metrics;
}

function readPlan(body: unknown): string | undefined {
  const payload = (body ?? undefined) as CodexRateLimits | undefined;
  if (payload?.planType) return String(payload.planType);
  const byId = payload?.rateLimitsByLimitId;
  const buckets = byId && typeof byId === "object" ? Object.values(byId) : undefined;
  const plan = buckets?.find((bucket) => bucket?.planType)?.planType ?? payload?.rateLimits?.planType;
  return plan ? String(plan) : undefined;
}

/**
 * Name the window after the duration Codex actually reported. The previous version
 * printed a literal "Session (5h)" for anything up to six hours, so a one-hour bucket
 * claimed a window five times its length.
 */
function windowLabel(minutes?: number): string {
  if (!minutes) return "Window";
  if (minutes < 60) return `Session (${minutes}m)`;
  if (minutes <= 6 * 60) return `Session (${Math.round(minutes / 60)}h)`;
  if (minutes <= 8 * 24 * 60) return `Weekly (${Math.round(minutes / 1440)}d)`;
  return `Window (${Math.round(minutes / 1440)}d)`;
}

function epochIso(value: unknown): string | undefined {
  const seconds = number(value);
  return seconds == null ? undefined : new Date(seconds * 1000).toISOString();
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeDetail(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 140);
}
