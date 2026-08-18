import type { Provider, ProviderContext, QuotaMetric, QuotaResult } from "./types.js";
import { fetchJson, nowIso } from "./util.js";

/**
 * MiniMax Coding Plan.
 *
 * The first plan since Claude and Codex to publish **plan quota** — rolling windows, not
 * an API credit balance — through an endpoint documented to take the user's own API key.
 * That is the surface this project is built to read, and the reason this adapter exists.
 *
 * It is also, today, unusable: the endpoint rejects bearer tokens and asks for a browser
 * session cookie instead (`1004: cookie is missing, log in again`, MiniMax-AI/MiniMax-M2#88,
 * open since March 2026). A session cookie is the line this project does not cross — it
 * is the same conduct removed for Antigravity and refused for Z.ai — so the adapter ships
 * unregistered, written against the documentation, and is switched on in
 * `src/providers/index.ts` the day a real key returns counters.
 *
 * Keeping it on disk rather than waiting is deliberate: when MiniMax fixes their side,
 * what is left is deleting a comment, not reading their documentation from scratch.
 */
const CONSOLE = "https://platform.minimax.io/user-center/basic-information";

/**
 * Two deployments, two routes for the same thing. Global first, because that is the one
 * the documentation this was written from describes; the China platform answers the same
 * shape under its own path.
 */
const ENDPOINTS = [
  "https://www.minimax.io/v1/token_plan/remains",
  "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
];

/** The counters the documentation names, plus the envelope every MiniMax route carries. */
interface CodingPlanRemains {
  base_resp?: { status_code?: unknown; status_msg?: unknown };
  current_interval_total_count?: unknown;
  current_interval_usage_count?: unknown;
  current_interval_reset_time?: unknown;
  current_week_total_count?: unknown;
  current_week_usage_count?: unknown;
  current_week_reset_time?: unknown;
  plan_name?: unknown;
}

/** MiniMax answers 200 with the failure inside the envelope, so the code is what matters. */
const COOKIE_DEMANDED = 1004;

const count = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * Seconds since the epoch in every MiniMax payload seen so far. Milliseconds are accepted
 * too rather than rendering a reset in 1970 if they ever change their mind.
 */
const resetIso = (value: unknown): string | undefined => {
  const seconds = count(value);
  if (!seconds) return undefined;
  const date = new Date(seconds < 100_000_000_000 ? seconds * 1_000 : seconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/**
 * Two rolling windows, the shape the reset horizon is built around: a short one that
 * refills through the day and a weekly cap behind it.
 */
export function parseCodingPlan(body: CodingPlanRemains | undefined): QuotaMetric[] {
  const windows: [string, unknown, unknown, unknown][] = [
    ["Session", body?.current_interval_usage_count, body?.current_interval_total_count, body?.current_interval_reset_time],
    ["Weekly", body?.current_week_usage_count, body?.current_week_total_count, body?.current_week_reset_time],
  ];

  const metrics: QuotaMetric[] = [];
  for (const [label, usedValue, totalValue, resetValue] of windows) {
    const used = count(usedValue);
    const limit = count(totalValue);
    // A window with a cap of zero is a plan that does not have it, not a plan that has
    // exhausted it: reporting 100% used would be a red card for a window nobody bought.
    if (used == null || !limit) continue;
    metrics.push({
      label,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      unit: "requests",
      resetAt: resetIso(resetValue),
    });
  }
  return metrics;
}

/**
 * One deployment, one request. Split out so the request shape — bearer auth, the envelope
 * MiniMax hides failures in — can be exercised against a real server rather than trusted.
 */
export async function readCodingPlan(endpoint: string, key: string): Promise<{
  metrics: QuotaMetric[];
  plan?: string;
  cookieDemanded: boolean;
  detail: string;
}> {
  const response = await fetchJson<CodingPlanRemains>(endpoint, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });

  const status = count(response.body?.base_resp?.status_code);
  const detail = String(response.body?.base_resp?.status_msg ?? response.text).slice(0, 200);
  const refused = status === COOKIE_DEMANDED || response.status === 401 || response.status === 403;

  return {
    metrics: refused || !response.ok ? [] : parseCodingPlan(response.body),
    plan: typeof response.body?.plan_name === "string" ? response.body.plan_name : undefined,
    cookieDemanded: status === COOKIE_DEMANDED,
    detail,
  };
}

/**
 * What the card says when MiniMax refuses its own documented authentication. Named,
 * because the one thing it must never do is read as "your key is wrong" — that sends
 * someone to regenerate a key that was never the problem.
 */
export const COOKIE_BUG_MESSAGE =
  "MiniMax rejects the API key its own documentation asks for and demands a browser " +
  "session cookie instead (upstream bug MiniMax-AI/MiniMax-M2#88). This project will " +
  "not lift a session cookie, so the card waits for MiniMax to honour bearer auth.";

export const minimax: Provider = {
  id: "minimax",
  name: "MiniMax Coding Plan",
  consoleUrl: CONSOLE,

  async fetch(ctx: ProviderContext): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "minimax",
      name: "MiniMax Coding Plan",
      status: "no_endpoint",
      consoleUrl: CONSOLE,
      sourceKind: "documented_api",
      sourceLabel: "MiniMax Coding Plan remains API",
      metrics: [],
      updatedAt: nowIso(),
    };

    const key = ctx.userKey;
    if (!key) {
      return {
        ...base,
        status: "unauthenticated",
        needsKey: true,
        message: "Paste a MiniMax API key to read the Coding Plan's rolling windows.",
      };
    }

    let cookieDemanded = false;
    let lastDetail = "";

    for (const endpoint of ENDPOINTS) {
      const attempt = await readCodingPlan(endpoint, key);
      cookieDemanded = cookieDemanded || attempt.cookieDemanded;
      lastDetail = attempt.detail || lastDetail;
      if (!attempt.metrics.length) continue;

      const exhausted = attempt.metrics.some((metric) => (metric.remaining ?? 1) <= 0);
      return {
        ...base,
        status: exhausted ? "rate_limited" : "ok",
        plan: attempt.plan,
        authSource: "MiniMax API key",
        sourceUpdatedAt: nowIso(),
        metrics: attempt.metrics,
        message: exhausted
          ? "MiniMax reports an exhausted Coding Plan window. Waiting for its reset."
          : undefined,
      };
    }

    if (cookieDemanded) {
      return {
        ...base,
        status: "unauthenticated",
        message: COOKIE_BUG_MESSAGE,
      };
    }

    return {
      ...base,
      status: "partial",
      message: `MiniMax did not return Coding Plan counters (${lastDetail || "no detail"}).`,
    };
  },
};
