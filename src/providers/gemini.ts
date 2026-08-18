import { homedir } from "node:os";

import type { Provider, QuotaMetric, QuotaResult } from "./types.js";
import {
  officialBridgeInstalled,
  readOfficialBridgeSnapshot,
  type OfficialBridgeSnapshot,
} from "../official-bridge.js";
import { reasonOf } from "../log.js";
import { nowIso } from "./util.js";

const CONSOLE = "https://antigravity.google/";
const FRESH_MS = 15 * 60_000;

/**
 * What the card says under a live bridge: an exhausted bucket explains itself, a stale
 * snapshot says how to refresh it, and a healthy one says nothing at all.
 */
function bridgeMessage(exhausted: boolean, stale: boolean): string | undefined {
  if (exhausted) return "Antigravity reports an exhausted quota bucket. Waiting for its official reset.";
  if (stale) return "This snapshot is old. Send a message in Antigravity: the status line publishes with the reply.";
  return undefined;
}

export const gemini: Provider = {
  id: "gemini",
  name: "Gemini",
  consoleUrl: CONSOLE,

  fetch: () => fetchGeminiQuota(),
};

/**
 * Split out from the adapter so the bridge-failure branches are reachable from a
 * test: `homedir()` is resolved once per process, so a fixture home can only be
 * passed in as an argument.
 */
export async function fetchGeminiQuota(home = homedir()): Promise<QuotaResult> {
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

  // The Provider contract forbids throwing, but the reason must not be dropped:
  // an unreadable ~/.gemini/antigravity-cli/settings.json means this card cannot tell whether the bridge is on,
  // and the user is the only one who can repair the file.
  let installed: boolean;
  try {
    installed = await officialBridgeInstalled("gemini", home);
  } catch (error) {
    return {
      ...base,
      status: "error",
      message: `Could not read the Antigravity settings file (${reasonOf(error)}). Repair ~/.gemini/antigravity-cli/settings.json, then reload.`,
    };
  }
  const snapshot = await readOfficialBridgeSnapshot("gemini", home);
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
      message: bridgeMessage(exhausted, stale),
    };
  }

  return {
    ...base,
    setupUrl: installed ? undefined : "/api/official-bridge/gemini",
    setupLabel: installed ? undefined : "Enable official bridge",
    teardownUrl: installed ? "/api/official-bridge/gemini" : undefined,
    teardownLabel: installed ? "Disable bridge" : undefined,
    message: installed
      ? "Bridge installed. Now send one message in Antigravity — launching it is not enough, because the status line publishes the quota along with a reply."
      : "Enable the Antigravity status-line bridge to receive model quota without OAuth or private APIs.",
  };
}

export function parseQuota(snapshot?: OfficialBridgeSnapshot): QuotaMetric[] {
  const quota = snapshot?.data?.quota;
  if (!quota || typeof quota !== "object") return [];
  const metrics: QuotaMetric[] = [];
  for (const [id, value] of Object.entries(quota) as [string, GeminiBucket][]) {
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

/** One quota bucket as the Antigravity status line writes it. */
interface GeminiBucket {
  remaining_fraction?: unknown;
  reset_time?: unknown;
  reset_in_seconds?: unknown;
}

function resetIso(value: GeminiBucket | undefined): string | undefined {
  if (typeof value?.reset_time === "string") {
    const date = new Date(value.reset_time);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const seconds = number(value?.reset_in_seconds);
  if (seconds == null) return undefined;
  const date = new Date(Date.now() + seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
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
