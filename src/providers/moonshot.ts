import type { Provider, ProviderContext, QuotaResult } from "./types.js";
import { fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://platform.moonshot.ai/console/account";
/** What the Open Platform balance endpoint answers with, as far as this reads it. */
interface MoonshotBalance {
  data?: { available_balance?: unknown };
}

const BALANCE_HOSTS = ["https://api.moonshot.ai", "https://api.moonshot.cn"];

export const moonshot: Provider = {
  id: "moonshot",
  name: "Kimi / Moonshot",
  consoleUrl: CONSOLE,

  async fetch(ctx: ProviderContext): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "moonshot",
      name: "Kimi / Moonshot",
      status: "no_endpoint",
      consoleUrl: CONSOLE,
      sourceKind: "documented_api",
      sourceLabel: "Moonshot Open Platform balance API",
      metrics: [],
      updatedAt: nowIso(),
    };

    const key = ctx.userKey;
    if (!key) {
      return {
        ...base,
        needsKey: true,
        message:
          "Kimi Code subscription quota remains in the official `/usage` panel. Paste an Open Platform key only to show API credit.",
      };
    }

    let unauthorized = 0;
    for (const host of BALANCE_HOSTS) {
      const res = await fetchJson<MoonshotBalance>(`${host}/v1/users/me/balance`, {
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      });
      if (res.status === 401 || res.status === 403) {
        unauthorized++;
        continue;
      }
      const data = res.body?.data;
      const balance = number(data?.available_balance);
      if (res.ok && balance != null) {
        return {
          ...base,
          status: "ok",
          authSource: host.includes(".cn") ? "Moonshot Platform CN key" : "Moonshot Platform global key",
          sourceUpdatedAt: nowIso(),
          metrics: [{ label: "Available API credit", remaining: balance, unit: "cny" }],
        };
      }
    }

    if (unauthorized === BALANCE_HOSTS.length) {
      return { ...base, status: "unauthenticated", needsKey: true, message: "Invalid Moonshot Open Platform key." };
    }
    return {
      ...base,
      status: "error",
      needsKey: true,
      message: "The documented Moonshot balance API is temporarily unavailable.",
    };
  },
};

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
