import type { Provider, QuotaMetric, QuotaResult } from "./types.js";
import { readClaude } from "../credentials.js";
import { fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://claude.ai/settings/usage";

// Anthropic exposes an OAuth usage endpoint used by Claude Code itself.
// Shape varies; we defensively pull whatever rate-limit windows it returns.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export const claude: Provider = {
  id: "claude",
  name: "Claude Code",
  consoleUrl: CONSOLE,

  async fetch(): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "claude",
      name: "Claude Code",
      status: "error",
      consoleUrl: CONSOLE,
      metrics: [],
      updatedAt: nowIso(),
    };

    const cred = await readClaude();
    if (!cred?.accessToken) {
      return {
        ...base,
        status: "unauthenticated",
        message: "Nessun login trovato in ~/.claude/.credentials.json. Esegui `claude` e fai il login.",
      };
    }

    const expired = cred.expiresAt && cred.expiresAt < Date.now();
    const tokenMetric: QuotaMetric = {
      label: "Token OAuth",
      resetAt: cred.expiresAt ? new Date(cred.expiresAt).toISOString() : undefined,
    };

    const res = await fetchJson(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
    });

    if (res.status === 429) {
      return {
        ...base,
        status: "rate_limited",
        authSource: "~/.claude/.credentials.json",
        metrics: [tokenMetric],
        message: "Anthropic ha risposto 429 (rate limited). Riprova tra poco.",
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ...base,
        status: expired ? "unauthenticated" : "partial",
        authSource: "~/.claude/.credentials.json",
        metrics: [tokenMetric],
        message: expired
          ? "Token OAuth scaduto: rifai il login con `claude`."
          : "Token presente ma l'endpoint usage ha rifiutato la richiesta (scope insufficienti).",
      };
    }

    const metrics = parseUsage(res.body);
    if (res.ok && metrics.length) {
      return {
        ...base,
        status: "ok",
        authSource: "~/.claude/.credentials.json",
        metrics: [...metrics, tokenMetric],
        raw: res.body,
      };
    }

    // Endpoint reachable but shape unknown / no windows returned.
    return {
      ...base,
      status: "partial",
      authSource: "~/.claude/.credentials.json",
      metrics: [tokenMetric],
      message: "Login attivo. Endpoint usage raggiunto ma senza finestre di quota leggibili; controlla la console.",
      raw: res.body ?? res.text?.slice(0, 300),
    };
  },
};

const KIND_LABEL: Record<string, string> = {
  session: "Sessione (5h)",
  weekly_all: "Settimanale (7g)",
};

// Live shape: body.limits[] = percent-based windows. Verified against the real endpoint.
export function parseUsage(body: any): QuotaMetric[] {
  if (!Array.isArray(body?.limits)) return [];
  return body.limits
    .filter((l: any) => typeof l?.percent === "number")
    .map((l: any) => ({
      label: KIND_LABEL[l.kind] ?? l.kind ?? "Finestra",
      used: l.percent,
      limit: 100,
      unit: "percent" as const,
      resetAt: iso(l.resets_at),
    }));
}

function iso(v: any): string | undefined {
  if (!v) return undefined;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : undefined;
}
