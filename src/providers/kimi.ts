import { homedir } from "node:os";
import { join } from "node:path";

import { readJson } from "../credentials.js";
import type { Provider, ProviderContext, QuotaMetric, QuotaResult } from "./types.js";
import { fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://www.kimi.com";
const USAGE_URLS = [
  "https://api.kimi.com/coding/v1/usages",
  "https://api.kimi.ai/coding/v1/usages",
];

interface KimiUsageDetail {
  used_ratio?: unknown;
  used?: unknown;
  limit?: unknown;
  remaining?: unknown;
  reset_time?: unknown;
  resets_at?: unknown;
  next_reset_time?: unknown;
}

interface KimiUsageBody {
  usages?: Record<string, KimiUsageDetail>;
  usage?: KimiUsageDetail;
}

const USAGE_WINDOWS = [
  ["limit_5h", "Session (5h)"],
  ["limit_7d", "Weekly (7d)"],
  ["limit_month_total", "Monthly"],
  ["limit_month_code", "Code month"],
] as const;

export const kimi: Provider = {
  id: "kimi",
  name: "Kimi Code",
  consoleUrl: CONSOLE,
  fetch: (ctx) => fetchKimiQuota(ctx),
};

export async function fetchKimiQuota(
  ctx: ProviderContext = {},
  home = homedir(),
): Promise<QuotaResult> {
  const base: QuotaResult = {
    id: "kimi",
    name: "Kimi Code",
    status: "unauthenticated",
    consoleUrl: CONSOLE,
    sourceKind: "official_client",
    sourceLabel: "Kimi Code usages",
    metrics: [],
    updatedAt: nowIso(),
  };

  const token = ctx.userKey || (await readKimiToken(home));
  if (!token) {
    return {
      ...base,
      needsKey: true,
      message: "Log in with the Kimi Code CLI (`kimi`) or paste a Coding Plan key.",
    };
  }

  let unauthorized = 0;
  for (const url of USAGE_URLS) {
    const response = await fetchJson<KimiUsageBody>(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      unauthorized++;
      continue;
    }
    const metrics = parseKimiUsages(response.body);
    if (response.ok && metrics.length) {
      const exhausted = metrics.some((metric) => (metric.remaining ?? 1) <= 0 || (metric.used ?? 0) >= 100);
      return {
        ...base,
        status: exhausted ? "rate_limited" : "ok",
        authSource: ctx.userKey ? "Kimi Coding Plan key" : "Kimi Code CLI session",
        sourceUpdatedAt: nowIso(),
        metrics,
        message: exhausted ? "Kimi reports an exhausted Coding Plan window." : undefined,
      };
    }
  }

  if (unauthorized === USAGE_URLS.length) {
    return { ...base, needsKey: true, message: "Kimi session expired. Run `kimi` login or paste a new key." };
  }
  return { ...base, status: "error", message: "Kimi Coding Plan usages endpoint is temporarily unavailable." };
}

export async function readKimiToken(home = homedir()): Promise<string | undefined> {
  const file = join(process.env.KIMI_HOME || join(home, ".kimi-code"), "credentials", "kimi-code.json");
  const data = await readJson<Record<string, unknown>>(file);
  const token = data?.access_token ?? data?.accessToken ?? data?.token;
  return typeof token === "string" && token ? token : undefined;
}

export function parseKimiUsages(body: KimiUsageBody | undefined): QuotaMetric[] {
  if (!body) return [];
  const metrics: QuotaMetric[] = [];
  const usages = body.usages;
  if (usages && typeof usages === "object") {
    for (const [key, label] of USAGE_WINDOWS) {
      const metric = usageMetric(label, usages[key]);
      if (metric) metrics.push(metric);
    }
  }
  if (!metrics.length) {
    const fallback = usageMetric("Weekly (7d)", body.usage);
    if (fallback) metrics.push(fallback);
  }
  return metrics;
}

function usageMetric(label: string, detail: KimiUsageDetail | undefined): QuotaMetric | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const ratio = number(detail.used_ratio);
  if (ratio != null) {
    const used = clampPercent(ratio <= 1 ? ratio * 100 : ratio);
    return { label, used, limit: 100, remaining: 100 - used, unit: "percent", resetAt: resetIso(detail) };
  }
  const limit = number(detail.limit);
  const used = number(detail.used);
  const remaining = number(detail.remaining);
  if (limit && limit > 0 && (used != null || remaining != null)) {
    const spent = used ?? Math.max(0, limit - (remaining ?? 0));
    return {
      label,
      used: spent,
      limit,
      remaining: Math.max(0, limit - spent),
      unit: "percent",
      resetAt: resetIso(detail),
    };
  }
  return undefined;
}

function resetIso(detail: KimiUsageDetail): string | undefined {
  const value = detail.reset_time ?? detail.resets_at ?? detail.next_reset_time;
  const numeric = number(value);
  if (numeric != null) {
    const ms = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
