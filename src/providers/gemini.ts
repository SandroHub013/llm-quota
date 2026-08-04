import type { Provider, QuotaMetric, QuotaResult } from "./types.js";
import {
  officialBridgeInstalled,
  readOfficialBridgeSnapshot,
  type OfficialBridgeSnapshot,
} from "../official-bridge.js";
import { nowIso } from "./util.js";

const CONSOLE = "https://antigravity.google/";
const FRESH_MS = 15 * 60_000;

export const gemini: Provider = {
  id: "gemini",
  name: "Gemini",
  consoleUrl: CONSOLE,

  async fetch(): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "gemini",
      name: "Gemini",
      status: "partial",
      consoleUrl: CONSOLE,
      sourceKind: "official_client",
      sourceLabel: "Antigravity status line",
      metrics: [],
      updatedAt: nowIso(),
    };

    const installed = await officialBridgeInstalled("gemini");
    const snapshot = await readOfficialBridgeSnapshot("gemini");
    const metrics = parseQuota(snapshot);
    if (snapshot && metrics.length) {
      const age = Date.now() - Date.parse(snapshot.capturedAt);
      const stale = age > FRESH_MS;
      const exhausted = metrics.some((metric) => (metric.used ?? 0) >= 100);
      return {
        ...base,
        status: exhausted ? "rate_limited" : stale ? "partial" : "ok",
        plan: typeof snapshot.data.planTier === "string" ? snapshot.data.planTier : undefined,
        authSource: "official status-line bridge",
        sourceUpdatedAt: snapshot.capturedAt,
        metrics,
        teardownUrl: installed ? "/api/official-bridge/gemini" : undefined,
        teardownLabel: installed ? "Disable bridge" : undefined,
        message: exhausted
          ? "Antigravity reports an exhausted quota bucket. Waiting for its official reset."
          : stale
            ? "Last official update is stale. Use Antigravity CLI once to refresh the quota snapshot."
            : undefined,
      };
    }

    return {
      ...base,
      setupUrl: installed ? undefined : "/api/official-bridge/gemini",
      setupLabel: installed ? undefined : "Enable official bridge",
      teardownUrl: installed ? "/api/official-bridge/gemini" : undefined,
      teardownLabel: installed ? "Disable bridge" : undefined,
      message: installed
        ? "Bridge installed. Start Antigravity CLI once to publish its official model quotas."
        : "Enable the Antigravity status-line bridge to receive model quota without OAuth or private APIs.",
    };
  },
};

export function parseQuota(snapshot?: OfficialBridgeSnapshot): QuotaMetric[] {
  const quota = snapshot?.data?.quota;
  if (!quota || typeof quota !== "object") return [];
  const metrics: QuotaMetric[] = [];
  for (const [id, value] of Object.entries(quota) as [string, any][]) {
    const remaining = number(value?.remaining_fraction);
    if (remaining == null) continue;
    metrics.push({
      label: readableBucket(id),
      used: Math.round(Math.max(0, Math.min(1, 1 - remaining)) * 100),
      limit: 100,
      unit: "percent",
      resetAt: resetIso(value),
    });
  }
  return metrics.sort((a, b) => (b.used ?? 0) - (a.used ?? 0));
}

function resetIso(value: any): string | undefined {
  if (typeof value?.reset_time === "string" && Number.isFinite(Date.parse(value.reset_time))) {
    return new Date(value.reset_time).toISOString();
  }
  const seconds = number(value?.reset_in_seconds);
  return seconds == null ? undefined : new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Antigravity splits the plan into a Gemini pool and a third-party pool
 * (Claude, GPT) and names the latter "3p", which reads as noise in the widget.
 * Unknown bucket names still fall through to plain title case.
 */
const BUCKET_WORDS: Record<string, string> = { "3p": "Third-party" };

function readableBucket(value: string): string {
  return value
    .split(/[_-]+/)
    .map((word) => BUCKET_WORDS[word.toLowerCase()] ?? word.replace(/^\w/, (letter) => letter.toUpperCase()))
    .join(" ");
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
