import { expect, test } from "bun:test";
import { parseZaiBridgeUsage } from "./zai.js";

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
