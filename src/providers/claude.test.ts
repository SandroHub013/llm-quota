import { expect, test } from "bun:test";
import { parseUsage } from "./claude.js";

// Real payload slice from api.anthropic.com/api/oauth/usage.
const LIVE = {
  limits: [
    { kind: "session", percent: 20, resets_at: "2026-07-23T16:59:59Z" },
    { kind: "weekly_all", percent: 34, resets_at: "2026-07-27T13:00:00Z" },
    { kind: "unknown_future", percent: null }, // must be skipped
  ],
};

test("parseUsage maps percent windows and skips non-numeric", () => {
  const m = parseUsage(LIVE);
  expect(m.map((x) => [x.label, x.used])).toEqual([
    ["Session (5h)", 20],
    ["Weekly (7d)", 34],
  ]);
});

test("parseUsage tolerates missing limits", () => {
  expect(parseUsage({})).toEqual([]);
  expect(parseUsage(null)).toEqual([]);
});
