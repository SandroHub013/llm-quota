import { expect, test } from "bun:test";
import { parseBridgeUsage } from "./claude.js";

const SNAPSHOT = {
  version: 1 as const,
  provider: "claude" as const,
  capturedAt: "2026-08-03T10:00:00Z",
  data: {
    rateLimits: {
      five_hour: { used_percentage: 20, resets_at: 1785757199 },
      seven_day: { used_percentage: 34, resets_at: 1786107600 },
    },
  },
};

test("official Claude status-line windows map to dashboard metrics", () => {
  const metrics = parseBridgeUsage(SNAPSHOT);
  expect(metrics.map((metric) => [metric.label, metric.used])).toEqual([
    ["Session (5h)", 20],
    ["Weekly (7d)", 34],
  ]);
  expect(metrics[0]!.resetAt).toBe(new Date(1785757199 * 1000).toISOString());
});

test("missing optional Claude windows are ignored", () => {
  expect(parseBridgeUsage()).toEqual([]);
  expect(parseBridgeUsage({ ...SNAPSHOT, data: {} })).toEqual([]);
});
