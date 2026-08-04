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
  expect(metrics.map((metric) => metric.label)).toEqual(["Codex \u00b7 Session (5h)", "Code review \u00b7 Session (1h)"]);
  expect(parseRateLimits({})).toEqual([]);
});

// The label used to be the literal string "Session (5h)" for every window up to six
// hours, so a shorter bucket claimed a window several times its real length.
test("a window is named after the duration Codex reported", () => {
  const labelFor = (windowDurationMins: number) =>
    parseRateLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins } } })[0]!.label;

  expect(labelFor(30)).toBe("Session (30m)");
  expect(labelFor(60)).toBe("Session (1h)");
  expect(labelFor(300)).toBe("Session (5h)");
  expect(labelFor(10_080)).toBe("Weekly (7d)");
  expect(labelFor(43_200)).toBe("Window (30d)");
});
