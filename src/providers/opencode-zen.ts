import type { Provider, ProviderContext, QuotaResult } from "./types.js";
import { readOpencode } from "../credentials.js";
import { fetchJson, nowIso } from "./util.js";

const CONSOLE = "https://opencode.ai/auth";

async function resolveKey(ctx: ProviderContext): Promise<{ key?: string; source?: string }> {
  if (ctx.userKey) return { key: ctx.userKey, source: "LLM Quota key" };
  const oc = await readOpencode();
  const entry = oc["opencode"] ?? oc["opencode-zen"] ?? oc["zen"];
  if (entry?.key) return { key: entry.key, source: "opencode auth" };
  if (entry?.access) return { key: entry.access, source: "opencode auth (oauth)" };
  return {};
}

export const opencodeZen: Provider = {
  id: "opencode-zen",
  name: "OpenCode Zen",
  consoleUrl: CONSOLE,

  async fetch(ctx: ProviderContext): Promise<QuotaResult> {
    const base: QuotaResult = {
      id: "opencode-zen",
      name: "OpenCode Zen",
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
        message: "No OpenCode Zen key. Paste one (opencode.ai console) to see credits.",
      };
    }

    // Zen gateway exposes only the OpenAI-compatible API: validate the key via models.list.
    // No public billing endpoint exists (credits are visible only in the web dashboard).
    const res = await fetchJson("https://opencode.ai/zen/v1/models", {
      headers: {
        Authorization: `Bearer ${key}`,
        // Cloudflare blocks non-browser user agents (error 1010).
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      },
    });

    if (res.status === 401 || res.status === 403) {
      return { ...base, status: "unauthenticated", needsKey: true, message: "Invalid OpenCode Zen key." };
    }

    const models = Array.isArray(res.body?.data) ? res.body.data.length : undefined;
    if (res.ok && models != null) {
      return {
        ...base,
        status: "partial",
        authSource: source,
        message: `Key is valid: ${models} models available. Zen exposes no credits over the API: the balance lives on opencode.ai.`,
        raw: { models },
      };
    }

    return {
      ...base,
      status: "no_endpoint",
      authSource: source,
      message: "Key present but no publicly readable credits endpoint. Check the OpenCode console.",
      raw: res.status ? `HTTP ${res.status}` : res.text?.slice(0, 200),
    };
  },
};

function num(v: any): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
