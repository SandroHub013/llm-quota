import { homedir } from "node:os";

import type { Provider, QuotaMetric, QuotaResult } from "./types.js";
import {
  officialBridgeInstalled,
  readOfficialBridgeSnapshot,
  type OfficialBridgeSnapshot,
} from "../official-bridge.js";
import { reasonOf } from "../log.js";
import { nowIso } from "./util.js";

const CONSOLE = "https://claude.ai/settings/usage";
const FRESH_MS = 15 * 60_000;

/**
 * What the card says under a live bridge: an exhausted window explains itself, a stale
 * snapshot says how to refresh it, and a healthy one says nothing at all.
 */
function bridgeMessage(exhausted: boolean, stale: boolean): string | undefined {
  if (exhausted) return "Claude reports an exhausted quota window. The card will recover after its official reset.";
  if (stale) return "This snapshot is old. Send a message in Claude Code: the status line publishes with the reply.";
  return undefined;
}

export const claude: Provider = {
  id: "claude",
  name: "Claude Code",
  consoleUrl: CONSOLE,

  fetch: () => fetchClaudeQuota(),
};

/**
 * Split out from the adapter so the bridge-failure branches are reachable from a
 * test: `homedir()` is resolved once per process, so a fixture home can only be
 * passed in as an argument.
 */
export async function fetchClaudeQuota(home = homedir()): Promise<QuotaResult> {
  const base: QuotaResult = {
    id: "claude",
    name: "Claude Code",
    status: "partial",
    consoleUrl: CONSOLE,
    sourceKind: "official_client",
    sourceLabel: "Claude Code status line",
    metrics: [],
    updatedAt: nowIso(),
  };

  // The Provider contract forbids throwing, but the reason must not be dropped:
  // an unreadable ~/.claude/settings.json means this card cannot tell whether the bridge is on,
  // and the user is the only one who can repair the file.
  let installed: boolean;
  try {
    installed = await officialBridgeInstalled("claude", home);
  } catch (error) {
    return {
      ...base,
      status: "error",
      message: `Could not read the Claude Code settings file (${reasonOf(error)}). Repair ~/.claude/settings.json, then reload.`,
    };
  }
  const snapshot = await readOfficialBridgeSnapshot("claude", home);
  const metrics = parseBridgeUsage(snapshot);
  if (snapshot && metrics.length) {
    const age = Date.now() - Date.parse(snapshot.capturedAt);
    const stale = age > FRESH_MS;
    const exhausted = metrics.some((metric) => (metric.used ?? 0) >= 100);
    return {
      ...base,
      status: exhausted ? "rate_limited" : stale ? "partial" : "ok",
      authSource: "official status-line bridge",
      sourceUpdatedAt: snapshot.capturedAt,
      metrics,
      teardownUrl: installed ? "/api/official-bridge/claude" : undefined,
      teardownLabel: installed ? "Disable bridge" : undefined,
      message: bridgeMessage(exhausted, stale),
    };
  }

  return {
    ...base,
    setupUrl: installed ? undefined : "/api/official-bridge/claude",
    setupLabel: installed ? undefined : "Enable official bridge",
    teardownUrl: installed ? "/api/official-bridge/claude" : undefined,
    teardownLabel: installed ? "Disable bridge" : undefined,
    message: installed
      ? "Bridge installed. Now send one message in Claude Code — opening it is not enough, because the status line publishes the quota along with a reply."
      : "Enable the official local bridge to receive 5-hour and 7-day quota without reading Claude OAuth.",
  };
}

/** One rolling window as the Claude Code status line writes it. */
interface ClaudeWindow {
  used_percentage?: unknown;
  resets_at?: unknown;
}

type ClaudeWindowKey = "five_hour" | "seven_day";

export function parseBridgeUsage(snapshot?: OfficialBridgeSnapshot): QuotaMetric[] {
  const limits = snapshot?.data?.rateLimits as Partial<Record<ClaudeWindowKey, ClaudeWindow>> | undefined;
  if (!limits || typeof limits !== "object") return [];
  const definitions = [
    ["five_hour", "Session (5h)"],
    ["seven_day", "Weekly (7d)"],
  ] as const;
  const metrics: QuotaMetric[] = [];
  for (const [key, label] of definitions) {
    const window = limits[key];
    const used = number(window?.used_percentage);
    if (used == null) continue;
    metrics.push({
      label,
      used: Math.max(0, Math.min(100, used)),
      limit: 100,
      unit: "percent",
      resetAt: epochIso(window?.resets_at),
    });
  }
  return metrics;
}

function epochIso(value: unknown): string | undefined {
  const seconds = number(value);
  if (seconds == null) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
