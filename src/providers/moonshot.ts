import type { Provider, ProviderContext, QuotaResult } from "./types.js";
import { readKimiCode, writeKimiCode, type KimiCreds } from "../credentials.js";
import { fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://platform.moonshot.ai/console/account";
// Public Kimi Code CLI OAuth client id (from the bundled CLI), used to refresh expired tokens.
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

/** Return a valid access token, refreshing (and writing back) if expired. Mirrors the CLI behavior. */
async function freshKimiToken(creds: KimiCreds): Promise<{ access: string } | { error: string }> {
  if (!creds.access_token || !creds.refresh_token) return { error: "no_tokens" };
  const expMs = (creds.expires_at ?? 0) * 1000;
  if (expMs > Date.now() + 60_000) return { access: creds.access_token };

  const res = await fetchJson("https://auth.kimi.com/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: KIMI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
    }).toString(),
  });
  if (res.ok && res.body?.access_token) {
    creds.access_token = res.body.access_token;
    if (res.body.refresh_token) creds.refresh_token = res.body.refresh_token;
    creds.expires_at = Math.floor(Date.now() / 1000) + Number(res.body.expires_in ?? 900);
    await writeKimiCode(creds);
    return { access: res.body.access_token };
  }
  return { error: res.body?.error ?? `http_${res.status}` };
}

export const moonshot: Provider = {
  id: "moonshot",
  name: "Kimi (Moonshot)",
  consoleUrl: CONSOLE,

  async fetch(ctx: ProviderContext): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "moonshot",
      name: "Kimi (Moonshot)",
      status: "error",
      consoleUrl: CONSOLE,
      metrics: [],
      updatedAt: nowIso(),
    };

    // Kimi Code coding-plan OAuth: live quota endpoint, verified. Refresh token if expired.
    const kimi = await readKimiCode();
    if (kimi?.access_token && !ctx.userKey) {
      const token = await freshKimiToken(kimi);
      if ("error" in token) {
        return {
          ...base,
          status: "unauthenticated",
          plan: kimi.scope,
          authSource: "~/.kimi-code",
          consoleUrl: "https://www.kimi.com/coding",
          message: `Token kimi-code scaduto e refresh fallito (${token.error}). Rifai \`kimi\` login.`,
        };
      }
      const res = await fetchJson("https://api.kimi.com/coding/v1/usages", {
        headers: { Authorization: `Bearer ${token.access}`, Accept: "application/json" },
      });
      const u = res.body?.usage;
      if (res.ok && u) {
        const metrics = [];
        const sess = res.body.limits?.[0]?.detail;
        if (sess)
          metrics.push({
            label: "Session (5h)",
            used: num(Number(sess.used)),
            limit: num(Number(sess.limit)),
            unit: "percent" as const,
            resetAt: sess.resetTime ? new Date(sess.resetTime).toISOString() : undefined,
          });
        metrics.push({
          label: "Weekly (7d)",
          used: num(Number(u.used)),
          limit: num(Number(u.limit)),
          unit: "percent" as const,
          resetAt: u.resetTime ? new Date(u.resetTime).toISOString() : undefined,
        });
        const level = res.body.user?.membership?.level?.replace("LEVEL_", "").toLowerCase();
        return {
          ...base,
          status: "ok",
          plan: level ?? kimi.scope,
          authSource: "~/.kimi-code",
          metrics,
          raw: res.body,
        };
      }
      return {
        ...base,
        status: res.status === 401 ? "unauthenticated" : "partial",
        plan: kimi.scope,
        authSource: "~/.kimi-code",
        consoleUrl: "https://www.kimi.com/coding",
        message:
          res.status === 401
            ? "kimi-code token expired: run `kimi` login again."
            : "kimi-code signed in, but quota is not readable right now. Check the Kimi console.",
      };
    }

    const key = ctx.userKey;
    if (!key) {
      return {
        ...base,
        status: "unauthenticated",
        needsKey: true,
        message: "No Kimi Code login found. Alternatively, paste a Moonshot API key to see your credit.",
      };
    }

    // Moonshot has a real balance endpoint. Try .ai then .cn.
    for (const host of ["https://api.moonshot.ai", "https://api.moonshot.cn"]) {
      const res = await fetchJson(`${host}/v1/users/me/balance`, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      });
      if (res.status === 401) {
        return { ...base, status: "unauthenticated", needsKey: true, message: "Invalid Moonshot API key." };
      }
      const d = res.body?.data;
      if (res.ok && d) {
        return {
          ...base,
          status: "ok",
          authSource: "LLM Quota key",
          metrics: [
            {
              label: "Available credit",
              remaining: num(d.available_balance),
              unit: "cny",
            },
          ],
          raw: res.body,
        };
      }
    }

    return {
      ...base,
      status: "error",
      needsKey: true,
      message: "Could not read Moonshot credit (endpoint unreachable or wrong key).",
    };
  },
};

function num(v: any): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
