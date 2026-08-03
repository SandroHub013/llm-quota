import { expect, test } from "bun:test";
import { parseRateLimits } from "./codex.js";

const LIVE = {
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1785266702 },
    secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1785871502 },
  },
};

test("app-server limits map to session and weekly windows", () => {
  const metrics = parseRateLimits(LIVE);
  expect(metrics.map((metric) => [metric.label, metric.used])).toEqual([
    ["Session (5h)", 12.5],
    ["Weekly (7d)", 34],
  ]);
  expect(metrics[0]!.resetAt).toBe(new Date(1785266702 * 1000).toISOString());
});

test("multi-bucket app-server payloads remain distinguishable", () => {
  const metrics = parseRateLimits({
    rateLimitsByLimitId: {
      codex: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 20, windowDurationMins: 300 } },
      review: { limitId: "review", limitName: "Code review", primary: { usedPercent: 40, windowDurationMins: 60 } },
    },
  });
  expect(metrics.map((metric) => metric.label)).toEqual(["Codex \u00b7 Session (5h)", "Code review \u00b7 Session (5h)"]);
  expect(parseRateLimits({})).toEqual([]);
});
