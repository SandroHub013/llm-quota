import type { Provider, QuotaMetric, QuotaResult } from "./types.js";
import {
  officialBridgeInstalled,
  readOfficialBridgeSnapshot,
  type OfficialBridgeSnapshot,
} from "../official-bridge.js";
import { nowIso } from "./util.js";

const CONSOLE = "https://z.ai/manage-apikey/apikey-list";
const FRESH_MS = 15 * 60_000;

export function parseZaiBridgeUsage(snapshot?: OfficialBridgeSnapshot): QuotaMetric[] {
  if (!snapshot?.data) return [];
  const metrics: QuotaMetric[] = [];
  const data = snapshot.data;

  // Never fall back to rateLimits: that field is Claude's own quota, not GLM's.
  const glm = data.glmQuota ?? data.zaiQuota;
  if (glm && typeof glm === "object") {
    if (typeof glm.used_percentage === "number") {
      metrics.push({
        label: "GLM Coding Plan",
        used: Math.min(100, Math.max(0, Math.round(glm.used_percentage))),
        limit: 100,
        unit: "percent",
        resetAt: typeof glm.resets_at === "number" ? new Date(glm.resets_at * 1000).toISOString() : glm.resets_at,
      });
    }
  }
  return metrics;
}

export const zai: Provider = {
  id: "zai",
  name: "z.ai",
  consoleUrl: CONSOLE,

  async fetch(): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "zai",
      name: "z.ai",
      status: "no_endpoint",
      consoleUrl: CONSOLE,
      sourceKind: "unavailable",
      sourceLabel: "official plugin / console",
      metrics: [],
      updatedAt: nowIso(),
    };

    const installed = await officialBridgeInstalled("zai");
    const snapshot = await readOfficialBridgeSnapshot("zai");
    const metrics = parseZaiBridgeUsage(snapshot);

    if (snapshot && metrics.length) {
      const age = Date.now() - Date.parse(snapshot.capturedAt);
      const stale = age > FRESH_MS;
      const exhausted = metrics.some((metric) => (metric.used ?? 0) >= 100);
      return {
        ...base,
        status: exhausted ? "rate_limited" : stale ? "partial" : "ok",
        sourceKind: "official_client",
        sourceLabel: "Z.ai Usage Query plugin",
        authSource: "official status-line bridge",
        sourceUpdatedAt: snapshot.capturedAt,
        metrics,
        teardownUrl: installed ? "/api/official-bridge/zai" : undefined,
        teardownLabel: installed ? "Disable bridge" : undefined,
        message: exhausted
          ? "Z.ai reports an exhausted GLM Coding Plan quota window."
          : stale
            ? "Last Z.ai official update is stale. Run Z.ai usage query plugin to refresh."
            : undefined,
      };
    }

    return {
      ...base,
      sourceKind: installed ? "official_client" : "unavailable",
      sourceLabel: installed ? "Z.ai Usage Query plugin" : "official plugin / console",
      setupUrl: installed ? undefined : "/api/official-bridge/zai",
      setupLabel: installed ? undefined : "Enable official bridge",
      teardownUrl: installed ? "/api/official-bridge/zai" : undefined,
      teardownLabel: installed ? "Disable bridge" : undefined,
      message: installed
        ? "Official Z.ai bridge active. Run Z.ai usage query plugin to populate quota."
        : "GLM Coding Plan quota is available through Z.ai's official Usage Query plugin; no public dashboard API is documented.",
    };
  },
};
