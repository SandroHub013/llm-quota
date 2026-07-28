import type { Provider, ProviderContext, QuotaMetric, QuotaResult } from "./types.js";
import { readGeminiOauth, writeGeminiOauth, type GeminiOauth } from "../credentials.js";
import { fetchJson, nowIso } from "./util.js";
import { CLOUDCODE_URL, CODE_ASSIST_METADATA, GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET, GEMINI_TOKEN_URL, GEMINI_UA } from "../gemini-oauth.js";

const CONSOLE = "https://aistudio.google.com/app/apikey";

/** Return a valid access token, refreshing (and writing back) if expired. */
async function freshToken(creds: GeminiOauth): Promise<{ access: string } | { error: string }> {
  if (!creds.access_token) return { error: "no_token" };
  if ((creds.expiry_date ?? 0) > Date.now() + 60_000) return { access: creds.access_token };
  if (!creds.refresh_token) return { error: "no_refresh_token" };

  const res = await fetchJson(GEMINI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
    }).toString(),
  });
  if (res.ok && res.body?.access_token) {
    creds.access_token = res.body.access_token;
    creds.expiry_date = Date.now() + Number(res.body.expires_in ?? 3600) * 1000;
    await writeGeminiOauth(creds);
    return { access: res.body.access_token };
  }
  return { error: res.body?.error ?? `http_${res.status}` };
}

function codeAssistHeaders(access: string) {
  return {
    Authorization: `Bearer ${access}`,
    "Content-Type": "application/json",
    "User-Agent": GEMINI_UA,
  };
}

/** Resolve the Code Assist project id, onboarding the user once if needed (mirrors the CLI). */
async function resolveProject(access: string): Promise<{ project: string; plan?: string } | { error: string }> {
  const headers = codeAssistHeaders(access);
  let res = await fetchJson(`${CLOUDCODE_URL}:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ metadata: CODE_ASSIST_METADATA }),
  });
  if (!res.ok) return { error: `loadCodeAssist http_${res.status}` };

  const plan = res.body?.paidTier?.name ?? res.body?.currentTier?.name;
  if (res.body?.cloudaicompanionProject) return { project: res.body.cloudaicompanionProject, plan };

  const tier = res.body?.allowedTiers?.find((t: any) => t.isDefault) ?? res.body?.allowedTiers?.[0];
  if (!tier?.id) return { error: "no_project_no_tier" };

  let op = await fetchJson(`${CLOUDCODE_URL}:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tierId: tier.id, metadata: CODE_ASSIST_METADATA }),
  });
  for (let i = 0; op.ok && op.body?.name && !op.body?.done && i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    op = await fetchJson(`${CLOUDCODE_URL}/${op.body.name}`, { headers });
  }

  res = await fetchJson(`${CLOUDCODE_URL}:loadCodeAssist`, {
    method: "POST",
    headers,
    body: JSON.stringify({ metadata: CODE_ASSIST_METADATA }),
  });
  if (res.ok && res.body?.cloudaicompanionProject) {
    return { project: res.body.cloudaicompanionProject, plan: res.body?.paidTier?.name ?? res.body?.currentTier?.name ?? plan };
  }
  return { error: "onboard_failed" };
}

export const gemini: Provider = {
  id: "gemini",
  name: "Gemini",
  consoleUrl: CONSOLE,

  async fetch(ctx: ProviderContext): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "gemini",
      name: "Gemini",
      status: "error",
      consoleUrl: CONSOLE,
      metrics: [],
      updatedAt: nowIso(),
    };

    const key = ctx.userKey;
    const oauth = await readGeminiOauth();

    if (!key && !oauth?.access_token) {
      return {
        ...base,
        status: "unauthenticated",
        needsKey: true,
        loginUrl: "/api/auth/gemini",
        message: "No Gemini login. Sign in with Google to use your subscription, or paste an AI Studio API key.",
      };
    }

    if (oauth?.access_token) {
      const token = await freshToken(oauth);
      if ("error" in token) {
        return {
          ...base,
          status: "unauthenticated",
          loginUrl: "/api/auth/gemini",
          authSource: "~/.gemini/oauth_creds.json",
          message: `Token Google scaduto e refresh fallito (${token.error}). Rifai login.`,
        };
      }

      const proj = await resolveProject(token.access);
      if ("error" in proj) {
        return {
          ...base,
          status: "partial",
          authSource: "~/.gemini/oauth_creds.json",
          message: `Login Google attivo ma Code Assist non risponde con un progetto (${proj.error}).`,
        };
      }

      const res = await fetchJson(`${CLOUDCODE_URL}:retrieveUserQuotaSummary`, {
        method: "POST",
        headers: codeAssistHeaders(token.access),
        body: JSON.stringify({ project: proj.project }),
      });

      const metrics = parseQuota(res.body);
      if (res.ok && metrics.length) {
        return {
          ...base,
          status: "ok",
          plan: proj.plan,
          authSource: "~/.gemini/oauth_creds.json",
          metrics,
          raw: res.body,
        };
      }

      if (res.status === 403) {
        return {
          ...base,
          status: "unauthenticated",
          plan: proj.plan,
          loginUrl: "/api/auth/gemini",
          authSource: "~/.gemini/oauth_creds.json",
          message: "Token from an old client: the server refuses the quota read. Sign in with Google again.",
        };
      }

      return {
        ...base,
        status: "partial",
        plan: proj.plan,
        authSource: "~/.gemini/oauth_creds.json",
        message: "Signed in, but Code Assist is not returning quota right now.",
        raw: res.body ?? res.text?.slice(0, 200),
      };
    }

    // API-key fallback: AI Studio keys have no public per-key usage endpoint; validate via models.list.
    const res = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key!)}`,
    );
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ...base, status: "unauthenticated", needsKey: true, message: "Invalid Gemini API key." };
    }
    if (res.ok) {
      return {
        ...base,
        status: "partial",
        authSource: "LLM Quota key",
        message:
          "Key is valid. Google does not expose per-key quota or rate limits over the API: usage lives in Google AI Studio / Cloud console.",
        metrics: [],
      };
    }
    return { ...base, status: "error", needsKey: true, message: `Errore Gemini (HTTP ${res.status}).` };
  },
};

// Real shape (retrieveUserQuotaSummary, antigravity tier): groups[].buckets[] with
// displayName + remainingFraction + resetTime. Older tiers returned flat buckets with
// a model field — handle both and keep raw for debugging.
// Google's display names ("Five Hour Limit") do not match how every other provider
// names the same window, so they are normalised to the dashboard's own vocabulary.
// Unknown names pass through untouched.
const WINDOW_LABEL: Record<string, string> = {
  "five hour limit": "Session (5h)",
  "daily limit": "Daily (24h)",
  "weekly limit": "Weekly (7d)",
  "monthly limit": "Monthly (30d)",
  "gemini models": "Gemini models",
  "claude and gpt models": "Claude and GPT models",
};

export function normaliseLabel(name: string): string {
  return name
    .split(" · ")
    .map((part) => WINDOW_LABEL[part.trim().toLowerCase()] ?? part)
    .join(" · ");
}

export function parseQuota(body: any): QuotaMetric[] {
  const out: QuotaMetric[] = [];
  const push = (label: string, frac: number, reset?: string) =>
    out.push({
      label: normaliseLabel(label),
      used: Math.round((1 - frac) * 100),
      limit: 100,
      unit: "percent",
      resetAt: reset ? new Date(reset).toISOString() : undefined,
    });

  const groups = body?.groups;
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (!Array.isArray(g?.buckets)) continue;
      for (const b of g.buckets) {
        if (typeof b?.remainingFraction !== "number") continue;
        const name = [g.displayName, b.displayName ?? b.bucketId].filter(Boolean).join(" · ");
        push(name, b.remainingFraction, b.resetTime);
      }
    }
  } else {
    const buckets = body?.buckets ?? body?.modelQuotas ?? body?.quotas;
    if (Array.isArray(buckets)) {
      for (const b of buckets) {
        const frac =
          typeof b.remainingFraction === "number"
            ? b.remainingFraction
            : typeof b.remaining_fraction === "number"
              ? b.remaining_fraction
              : undefined;
        const model = b.modelId ?? b.model ?? b.modelName ?? b.displayName;
        if (frac == null || !model) continue;
        push(String(model), frac, b.resetTime ?? b.reset_time);
      }
    }
  }
  out.sort((a, b) => (b.used ?? 0) - (a.used ?? 0));
  return out;
}
