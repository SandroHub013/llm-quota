import { number } from "./rows.js";
import type { RawUsageRow } from "./types.js";

interface Price {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  output: number;
}

// Public API list prices in USD per million tokens, checked 2026-08-02.
// Sources: developers.openai.com/api/docs/models, platform.claude.com/docs/en/about-claude/pricing,
// docs.z.ai/guides/overview/pricing, and platform.kimi.ai/docs/pricing/chat.
// Reasoning tokens are included in output tokens by every supported log format.
const PRICES: Record<string, Price> = {
  "gpt-5.6-sol": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 30 },
  "gpt-5.6-terra": { input: 2.5, cacheRead: 0.25, cacheWrite: 3.125, output: 15 },
  "gpt-5.6-luna": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 6 },
  "gpt-5.5": { input: 5, cacheRead: 0.5, cacheWrite: 5, output: 30 },

  "claude-fable-5": { input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-4-8": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 },
  "claude-opus-4-7": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25 },
  // Introductory price through 2026-08-31.
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, output: 10 },
  "claude-sonnet-4-6": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 },
  "claude-sonnet-4-5": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5 },

  "glm-5.2": { input: 1.4, cacheRead: 0.26, cacheWrite: 1.4, output: 4.4 },
  "glm-5.1": { input: 1.4, cacheRead: 0.26, cacheWrite: 1.4, output: 4.4 },
  "glm-5": { input: 1, cacheRead: 0.2, cacheWrite: 1, output: 3.2 },
  "glm-5-turbo": { input: 1.2, cacheRead: 0.24, cacheWrite: 1.2, output: 4 },
  "glm-4.7": { input: 0.6, cacheRead: 0.11, cacheWrite: 0.6, output: 2.2 },
  "glm-4.5-air": { input: 0.2, cacheRead: 0.03, cacheWrite: 0.2, output: 1.1 },

  "kimi-k3": { input: 3, cacheRead: 0.3, cacheWrite: 3, output: 15 },
  "kimi-k2.7-code": { input: 0.95, cacheRead: 0.19, cacheWrite: 0.95, output: 4 },
  "kimi-k2.7-code-highspeed": { input: 1.9, cacheRead: 0.38, cacheWrite: 1.9, output: 8 },
};

export const USD_PER_EUR = 1.1485;
export const PRICING_AS_OF = "2026-08-02";
export const FX_AS_OF = "2026-07-31";

export const normalizedModel = (model: string): string => {
  const value = model.toLowerCase().replace(/_/g, "-").replace(/-\d{8}$/, "");
  if (value === "gpt-5.6" || value === "gpt-5.6-sol-pro") return "gpt-5.6-sol";
  if (value.endsWith("/k3") || value === "k3") return "kimi-k3";
  if (value.includes("k2.7") && value.includes("highspeed")) return "kimi-k2.7-code-highspeed";
  if (value.includes("k2.7")) return "kimi-k2.7-code";
  const providerModel = value.split("/").at(-1)!;
  if (PRICES[providerModel]) return providerModel;
  return value;
};

const priceFor = (model: string, effort = ""): Price | undefined => {
  const key = normalizedModel(model);
  if (key.endsWith("-free")) return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  if (effort.includes("fast")) {
    if (key === "claude-opus-5" || key === "claude-opus-4-8") {
      return { input: 10, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50 };
    }
    if (key === "claude-opus-4-7") {
      return { input: 30, cacheRead: 3, cacheWrite: 37.5, cacheWrite1h: 60, output: 150 };
    }
  }
  return PRICES[key];
};

export const displayModel = (model: string): string => {
  const key = normalizedModel(model);
  const known: Record<string, string> = {
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.5": "GPT-5.5",
    "claude-fable-5": "Claude Fable 5",
    "claude-opus-5": "Claude Opus 5",
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-sonnet-5": "Claude Sonnet 5",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "glm-5.2": "GLM-5.2",
    "glm-5.1": "GLM-5.1",
    "glm-5": "GLM-5",
    "glm-5-turbo": "GLM-5 Turbo",
    "glm-4.7": "GLM-4.7",
    "glm-4.5-air": "GLM-4.5 Air",
    "kimi-k3": "Kimi K3",
    "kimi-k2.7-code": "Kimi K2.7 Code",
    "kimi-k2.7-code-highspeed": "Kimi K2.7 Code Highspeed",
  };
  return known[key] ?? model;
};

export function costOf(row: RawUsageRow): { usd?: number; basis?: "public_list" | "recorded" } {
  const price = priceFor(row.model, row.effort);
  if (price) {
    const cache1h = number(row.cacheWrite1h);
    const cache5m = row.cacheWrite5m == null
      ? Math.max(0, row.cacheWrite - cache1h)
      : number(row.cacheWrite5m);
    const usd = (
      row.input * price.input +
      row.cacheRead * price.cacheRead +
      cache5m * price.cacheWrite +
      cache1h * (price.cacheWrite1h ?? price.cacheWrite) +
      row.output * price.output
    ) / 1_000_000;
    return { usd, basis: "public_list" };
  }
  if (row.recordedCostUsd != null) return { usd: row.recordedCostUsd, basis: "recorded" };
  return {};
}
