import type { Provider, QuotaMetric, QuotaResult } from "./types.js";
import { readCodex, writeCodex, decodeJwt, type CodexAuth } from "../credentials.js";
import { fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://chatgpt.com/#settings";
// Public Codex CLI OAuth client id (used to refresh the ChatGPT session token).
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const UA = "codex_cli_rs/0.20.0 (LLM Quota)";

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
      metrics: [],
      updatedAt: nowIso(),
    };

    const auth = await readCodex();
    if (!auth?.tokens?.access_token || !auth.tokens.refresh_token) {
      return { ...base, status: "unauthenticated", message: "No login in ~/.codex/auth.json. Run `codex login`." };
    }

    const plan = readPlan(auth);
    const token = await ensureFreshToken(auth);
    if ("error" in token) {
      const stale = token.error === "refresh_token_reused" || token.error === "invalid_grant";
      return {
        ...base,
        status: "unauthenticated",
        plan,
        authSource: "~/.codex/auth.json",
        message: stale
          ? "Codex token expired and the refresh token is spent. Run `codex login` once to renew it."
          : `Refresh token fallito (${token.error}).`,
      };
    }

    // wham = current Codex usage namespace; codex = legacy fallback.
    const headers = {
      Authorization: `Bearer ${token.access}`,
      "chatgpt-account-id": auth.tokens.account_id ?? "",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      "User-Agent": UA,
      "Content-Type": "application/json",
    };
    let res = await fetchJson("https://chatgpt.com/backend-api/wham/usage", { headers });
    if (res.status === 404 || res.status === 401) {
      res = await fetchJson("https://chatgpt.com/backend-api/codex/usage", { headers });
    }

    if (res.status === 429) {
      return { ...base, status: "rate_limited", plan, authSource: "~/.codex/auth.json", message: "ChatGPT returned 429." };
    }

    const metrics = parseUsage(res.body);
    if (res.ok && metrics.length) {
      return { ...base, status: "ok", plan, authSource: "~/.codex/auth.json", metrics, raw: res.body };
    }

    return {
      ...base,
      status: plan ? "partial" : "no_endpoint",
      plan,
      authSource: "~/.codex/auth.json",
      message: "Signed in, but the usage endpoint returned no readable windows. Check the console.",
      raw: res.body ?? res.text?.slice(0, 200),
    };
  },
};

/** Return a valid access token, refreshing (and writing back) if the current one is expired. */
async function ensureFreshToken(auth: CodexAuth): Promise<{ access: string } | { error: string }> {
  const at = auth.tokens!.access_token!;
  const claims = decodeJwt(at);
  const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : 0;
  if (exp > Date.now() + 60_000) return { access: at }; // still valid (>1 min headroom)

  const res = await fetchJson("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: auth.tokens!.refresh_token,
      scope: "openid profile email",
    }),
  });

  if (res.ok && res.body?.access_token) {
    auth.tokens!.access_token = res.body.access_token;
    if (res.body.refresh_token) auth.tokens!.refresh_token = res.body.refresh_token;
    if (res.body.id_token) auth.tokens!.id_token = res.body.id_token;
    auth.last_refresh = new Date().toISOString();
    await writeCodex(auth); // persist the rotated tokens, like the CLI does
    return { access: res.body.access_token };
  }
  return { error: res.body?.error?.code ?? `http_${res.status}` };
}

function readPlan(auth: CodexAuth): string | undefined {
  const claims = decodeJwt(auth.tokens?.id_token ?? auth.tokens?.access_token ?? "") ?? {};
  const a = claims["https://api.openai.com/auth"] ?? {};
  const p = a.chatgpt_plan_type ?? a.chatgpt_subscription_plan ?? claims.plan;
  return p ? String(p) : undefined;
}

// Real shape (wham/usage): { rate_limit: { primary_window, secondary_window } }.
// Each window: { used_percent, limit_window_seconds, reset_after_seconds, reset_at (unix s) }.
export function parseUsage(body: any): QuotaMetric[] {
  const rl = body?.rate_limit;
  if (!rl || typeof rl !== "object") return [];
  const out: QuotaMetric[] = [];
  for (const w of [rl.primary_window, rl.secondary_window]) {
    if (!w || typeof w !== "object") continue;
    const pct = num(w.used_percent);
    if (pct == null) continue;
    out.push({
      label: windowLabel(num(w.limit_window_seconds)),
      used: Math.round(pct),
      limit: 100,
      unit: "percent",
      resetAt: resetFrom(w),
    });
  }
  return out;
}

function windowLabel(secs?: number): string {
  if (!secs) return "Window";
  if (secs <= 6 * 3600) return "Session (5h)";
  if (secs <= 8 * 86400) return "Weekly (7d)";
  return `Finestra (${Math.round(secs / 86400)}g)`;
}

function resetFrom(w: any): string | undefined {
  if (typeof w.reset_at === "number") return new Date(w.reset_at * 1000).toISOString();
  const secs = num(w.reset_after_seconds ?? w.resets_in_seconds);
  return secs != null ? new Date(Date.now() + secs * 1000).toISOString() : undefined;
}

function num(v: any): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
