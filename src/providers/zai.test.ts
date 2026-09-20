import { expect, test } from "bun:test";
import { parseZaiBridgeUsage, parseZaiLimits } from "./zai.js";

test("official Z.ai status-line quota maps remaining fractions and resets", () => {
  const metrics = parseZaiBridgeUsage({
    version: 1,
    provider: "zai",
    capturedAt: "2026-08-03T12:00:00.000Z",
    data: {
      glmQuota: {
        used_percentage: 42,
        resets_at: 1785757199,
      },
    },
  });

  expect(metrics).toEqual([
    {
      label: "GLM Coding Plan",
      used: 42,
      limit: 100,
      unit: "percent",
      resetAt: new Date(1785757199 * 1000).toISOString(),
    },
  ]);
});

test("missing or empty Z.ai payload returns empty metrics", () => {
  expect(parseZaiBridgeUsage(undefined)).toEqual([]);
  expect(parseZaiBridgeUsage({ version: 1, provider: "zai", capturedAt: "2026-08-03T12:00:00Z", data: {} })).toEqual([]);
});

test("Z.ai HTTP limits become session, weekly and MCP metrics", () => {
  const parsed = parseZaiLimits({
    data: {
      level: "pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 22, nextResetTime: 1785757199 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 40, nextResetTime: 1786107600 },
        { type: "TIME_LIMIT", percentage: 10 },
      ],
    },
  });

  expect(parsed.plan).toBe("pro");
  expect(parsed.metrics.map((metric) => [metric.label, metric.used])).toEqual([
    ["Session (5h)", 22],
    ["Weekly (7d)", 40],
    ["MCP month", 10],
  ]);
});

test("an empty Z.ai limits payload is no metrics", () => {
  expect(parseZaiLimits(undefined).metrics).toEqual([]);
  expect(parseZaiLimits({}).metrics).toEqual([]);
});
