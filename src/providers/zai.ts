import type { Provider, ProviderContext, QuotaResult } from "./types.js";
import { readOpencode } from "../credentials.js";
import { fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://z.ai/manage-apikey/apikey-list";

async function resolveKey(ctx: ProviderContext): Promise<{ key?: string; source?: string }> {
  if (ctx.userKey) return { key: ctx.userKey, source: "chiave LLM Quota" };
  const oc = await readOpencode();
  const entry = oc["zai-coding-plan"] ?? oc["zai"] ?? oc["z-ai"];
  if (entry?.key) return { key: entry.key, source: "opencode (zai-coding-plan)" };
  return {};
}

export const zai: Provider = {
  id: "zai",
  name: "z.ai",
  consoleUrl: CONSOLE,

  async fetch(ctx: ProviderContext): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "zai",
      name: "z.ai",
      status: "error",
      consoleUrl: CONSOLE,
      metrics: [],
      updatedAt: nowIso(),
    };

    const { key, source } = await resolveKey(ctx);
    if (!key) {
      return {
        ...base,
        status: "unauthenticated",
        needsKey: true,
        message: "Nessuna API key z.ai. Incollala qui sotto (la trovi nella console z.ai).",
      };
    }

    // z.ai coding-plan quota: undocumented monitor endpoint, verified live.
    const res = await fetchJson("https://api.z.ai/api/monitor/usage/quota/limit", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });

    const limits = res.body?.data?.limits;
    if (res.ok && Array.isArray(limits)) {
      const metrics = [];
      for (const l of limits) {
        const resetAt = l.nextResetTime ? new Date(Number(l.nextResetTime)).toISOString() : undefined;
        if (l.type === "TOKENS_LIMIT" && l.unit === 3)
          metrics.push({ label: "Token (5h)", used: num(l.percentage), limit: 100, unit: "percent" as const, resetAt });
        if (l.type === "TOKENS_LIMIT" && l.unit === 6)
          metrics.push({ label: "Token (mese)", used: num(l.percentage), limit: 100, unit: "percent" as const, resetAt });
        if (l.type === "TIME_LIMIT")
          metrics.push({ label: "Tool web (mese)", used: num(l.percentage), limit: 100, unit: "percent" as const, resetAt });
      }
      if (metrics.length) {
        return { ...base, status: "ok", authSource: source, plan: res.body.data.level, metrics, raw: res.body };
      }
    }

    return {
      ...base,
      status: "no_endpoint",
      authSource: source,
      needsKey: false,
      message:
        "Key z.ai attiva, ma il coding plan non espone un endpoint quota pubblico. Apri la console per vedere i prompt residui.",
      raw: res.status ? `HTTP ${res.status}` : res.text?.slice(0, 200),
    };
  },
};

function num(v: any): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
