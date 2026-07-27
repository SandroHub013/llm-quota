import type { Provider, QuotaMetric, QuotaResult } from "./types.js";
import { readClaude } from "../credentials.js";
import { fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://claude.ai/settings/usage";

// Anthropic exposes an OAuth usage endpoint used by Claude Code itself.
// Shape varies; we defensively pull whatever rate-limit windows it returns.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

let cache: { result: QuotaResult; timestamp: number } | null = null;
const CACHE_TTL_MS = 60_000; // Cache 60s per normal responses
const RATE_LIMIT_TTL_MS = 3 * 60_000; // Cache 3m for 429 rate-limited responses

export function clearClaudeCache() {
  cache = null;
}

export const claude: Provider = {
  id: "claude",
  name: "Claude Code",
  consoleUrl: CONSOLE,

  async fetch(): Promise<QuotaResult> {
    const now = Date.now();
    if (cache) {
      const ttl = cache.result.status === "rate_limited" ? RATE_LIMIT_TTL_MS : CACHE_TTL_MS;
      if (now - cache.timestamp < ttl) {
        return {
          ...cache.result,
          updatedAt: nowIso(),
        };
      }
    }

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
      const res: QuotaResult = {
        ...base,
        status: "unauthenticated",
        message: "Nessun login trovato in ~/.claude/.credentials.json. Esegui `claude` e fai il login.",
      };
      cache = { result: res, timestamp: now };
      return res;
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

    let result: QuotaResult;

    if (res.status === 429) {
      result = {
        ...base,
        status: "rate_limited",
        authSource: "~/.claude/.credentials.json",
        metrics: [tokenMetric],
        message: "Anthropic ha risposto 429 (rate limited). In pausa per 3 minuti per permettere il reset del limit.",
      };
    } else if (res.status === 401 || res.status === 403) {
      result = {
        ...base,
        status: expired ? "unauthenticated" : "partial",
        authSource: "~/.claude/.credentials.json",
        metrics: [tokenMetric],
        message: expired
          ? "Token OAuth scaduto: rifai il login con `claude`."
          : "Token presente ma l'endpoint usage ha rifiutato la richiesta (scope insufficienti).",
      };
    } else {
      const metrics = parseUsage(res.body);
      if (res.ok && metrics.length) {
        result = {
          ...base,
          status: "ok",
          authSource: "~/.claude/.credentials.json",
          metrics: [...metrics, tokenMetric],
          raw: res.body,
        };
      } else {
        result = {
          ...base,
          status: "partial",
          authSource: "~/.claude/.credentials.json",
          metrics: [tokenMetric],
          message: "Login attivo. Endpoint usage raggiunto ma senza finestre di quota leggibili; controlla la console.",
          raw: res.body ?? res.text?.slice(0, 300),
        };
      }
    }

    cache = { result, timestamp: now };
    return result;
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
