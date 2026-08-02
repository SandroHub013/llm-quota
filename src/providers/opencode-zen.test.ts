import { afterEach, expect, test } from "bun:test";
import { opencodeZen } from "./opencode-zen.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("free Zen models become individual fair-use availability rows, not fake quotas", async () => {
  globalThis.fetch = (async () => Response.json({
    data: [
      { id: "deepseek-v4-flash-free", object: "model", owned_by: "opencode" },
      { id: "mimo-v2.5-free", object: "model", owned_by: "opencode" },
      { id: "gpt-5.6-sol", object: "model", owned_by: "openai" },
    ],
  })) as unknown as typeof fetch;

  const result = await opencodeZen.fetch({ userKey: "test-key" });

  expect(result.status).toBe("ok");
  expect(result.metrics).toEqual([
    { label: "DeepSeek V4 Flash", availability: "listed" },
    { label: "MiMo V2.5", availability: "listed" },
  ]);
  expect(result.metrics.every((metric) => metric.remaining == null && metric.used == null)).toBe(true);
  expect(result.message).toContain("does not publish numeric free-model quotas");
});
