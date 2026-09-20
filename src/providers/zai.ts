import { homedir } from "node:os";
import { join } from "node:path";

import { readJson } from "../credentials.js";
import type { OfficialBridgeSnapshot } from "../official-bridge.js";
import {
  officialBridgeInstalled,
  readOfficialBridgeSnapshot,
} from "../official-bridge.js";
import type { Provider, ProviderContext, QuotaMetric, QuotaResult } from "./types.js";
import { bridgeStatus, fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://z.ai/manage-apikey/apikey-list";
const BRIDGE_URL = "/api/official-bridge/zai";
const PLUGIN_LABEL = "Z.ai Usage Query plugin";
const FRESH_MS = 15 * 60_000;
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const HOSTS = ["api.z.ai", "open.bigmodel.cn"];

interface ZaiQuota {
  used_percentage?: unknown;
  resets_at?: unknown;
}

interface ZaiLimit {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  currentValue?: unknown;
  usage?: unknown;
  nextResetTime?: unknown;
}

interface ZaiQuotaBody {
  data?: { limits?: ZaiLimit[]; level?: unknown };
  limits?: ZaiLimit[];
  level?: unknown;
}

function resetIso(resets: unknown): string | undefined {
  if (typeof resets === "number") {
    const ms = resets < 100_000_000_000 ? resets * 1000 : resets;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return typeof resets === "string" ? resets : undefined;
}

export function parseZaiBridgeUsage(snapshot?: OfficialBridgeSnapshot): QuotaMetric[] {
  if (!snapshot?.data) return [];
  const glm = (snapshot.data.glmQuota ?? snapshot.data.zaiQuota) as ZaiQuota | undefined;
  if (!glm || typeof glm !== "object" || typeof glm.used_percentage !== "number") return [];
  return [{
    label: "GLM Coding Plan",
    used: Math.min(100, Math.max(0, Math.round(glm.used_percentage))),
    limit: 100,
    unit: "percent",
    resetAt: resetIso(glm.resets_at),
  }];
}

export function parseZaiLimits(body: ZaiQuotaBody | undefined): { metrics: QuotaMetric[]; plan?: string } {
  const data = body?.data ?? body;
  const limits = data?.limits;
  if (!Array.isArray(limits)) return { metrics: [] };
  const metrics: QuotaMetric[] = [];
  for (const entry of limits) {
    const metric = mapLimit(entry);
    if (metric) metrics.push(metric);
  }
  const plan = typeof data?.level === "string" ? data.level : undefined;
  return { metrics, plan };
}

function mapLimit(entry: ZaiLimit | undefined): QuotaMetric | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const used = percentUsed(entry);
  if (used == null) return undefined;
  return {
    label: limitLabel(entry),
    used,
    limit: 100,
    remaining: 100 - used,
    unit: "percent",
    resetAt: resetIso(entry.nextResetTime),
  };
}

function percentUsed(entry: ZaiLimit): number | undefined {
  const percentage = number(entry.percentage);
  if (percentage != null) return Math.min(100, Math.max(0, percentage));
  const current = number(entry.currentValue);
  const usage = number(entry.usage);
  if (usage && usage > 0 && current != null) return Math.min(100, Math.max(0, (current / usage) * 100));
  return undefined;
}

function limitLabel(entry: ZaiLimit): string {
  const type = typeof entry.type === "string" ? entry.type : "";
  const unit = number(entry.unit);
  const count = number(entry.number);
  if ((type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") && unit === 3 && count === 5) return "Session (5h)";
  if ((type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") && unit === 6 && count === 1) return "Weekly (7d)";
  if (type === "TIME_LIMIT") return "MCP month";
  return type || "Quota";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bridgeMessage(exhausted: boolean, stale: boolean): string | undefined {
  if (exhausted) return "Z.ai reports an exhausted GLM Coding Plan quota window.";
  if (stale) return "Last Z.ai official update is stale. Run Z.ai usage query plugin to refresh.";
  return undefined;
}

export const zai: Provider = {
  id: "zai",
  name: "z.ai",
  consoleUrl: CONSOLE,
  fetch: (ctx) => fetchZaiQuota(ctx),
};

export async function fetchZaiQuota(
  ctx: ProviderContext = {},
  home = homedir(),
): Promise<QuotaResult> {
  const base: QuotaResult = {
    id: "zai",
    name: "z.ai",
    status: "unauthenticated",
    consoleUrl: CONSOLE,
    sourceKind: "official_client",
    sourceLabel: "Z.ai Coding Plan quota",
    metrics: [],
    updatedAt: nowIso(),
  };

  const installed = await officialBridgeInstalled("zai", home);
  const snapshot = await readOfficialBridgeSnapshot("zai", home);
  const bridged = parseZaiBridgeUsage(snapshot);
  if (snapshot && bridged.length) {
    const age = Date.now() - Date.parse(snapshot.capturedAt);
    const stale = age > FRESH_MS;
    const exhausted = bridged.some((metric) => (metric.used ?? 0) >= 100);
    return {
      ...base,
      status: bridgeStatus(exhausted, stale),
      sourceLabel: PLUGIN_LABEL,
      authSource: "official status-line bridge",
      sourceUpdatedAt: snapshot.capturedAt,
      metrics: bridged,
      teardownUrl: installed ? BRIDGE_URL : undefined,
      teardownLabel: installed ? "Disable bridge" : undefined,
      message: bridgeMessage(exhausted, stale),
    };
  }

  const key = ctx.userKey || (await readZaiKey(home));
  if (key) {
    let unauthorized = 0;
    for (const host of HOSTS) {
      const response = await fetchJson<ZaiQuotaBody>(`https://${host}${QUOTA_PATH}`, {
        headers: { Authorization: key, Accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403) {
        unauthorized++;
        continue;
      }
      const parsed = parseZaiLimits(response.body);
      if (response.ok && parsed.metrics.length) {
        const exhausted = parsed.metrics.some((metric) => (metric.remaining ?? 1) <= 0 || (metric.used ?? 0) >= 100);
        return {
          ...base,
          status: exhausted ? "rate_limited" : "ok",
          plan: parsed.plan,
          authSource: ctx.userKey ? "Z.ai API key" : "local Z.ai credential",
          sourceUpdatedAt: nowIso(),
          metrics: parsed.metrics,
          message: exhausted ? "Z.ai reports an exhausted GLM Coding Plan window." : undefined,
        };
      }
    }
    if (unauthorized === HOSTS.length) {
      return { ...base, needsKey: true, message: "Z.ai key rejected. Paste a Coding Plan key from z.ai." };
    }
  }

  return {
    ...base,
    needsKey: !ctx.userKey,
    setupUrl: installed ? undefined : BRIDGE_URL,
    setupLabel: installed ? undefined : "Enable official bridge",
    teardownUrl: installed ? BRIDGE_URL : undefined,
    teardownLabel: installed ? "Disable bridge" : undefined,
    message: key
      ? "Z.ai quota endpoint is temporarily unavailable."
      : "Paste a Z.ai Coding Plan key, or enable the official bridge and run the Usage Query plugin.",
  };
}

export async function readZaiKey(home = homedir()): Promise<string | undefined> {
  const candidates = [
    join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json"),
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "opencode", "auth.json")] : []),
    join(process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "auth.json"),
  ];
  for (const path of candidates) {
    const data = await readJson<Record<string, unknown>>(path);
    const key = extractZaiKey(data);
    if (key) return key;
  }
  return undefined;
}

function extractZaiKey(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  for (const id of ["zai-coding-plan", "zai", "z-ai", "z.ai", "zhipu", "zhipuai"]) {
    const entry = data[id];
    if (typeof entry === "string" && entry) return entry;
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      for (const field of ["key", "apiKey", "api_key", "token", "accessToken"]) {
        const value = record[field];
        if (typeof value === "string" && value) return value;
      }
    }
  }
  return undefined;
}
