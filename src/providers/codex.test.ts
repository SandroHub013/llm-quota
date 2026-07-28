import { expect, test } from "bun:test";
import { parseUsage } from "./codex.js";

// Real payload slice from chatgpt.com/backend-api/wham/usage.
const LIVE = {
  rate_limit: {
    allowed: false,
    limit_reached: true,
    primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1785266702 },
    secondary_window: null,
  },
};

test("parseUsage reads the weekly window and labels it by duration", () => {
  const m = parseUsage(LIVE);
  expect(m).toHaveLength(1);
  expect(m[0]!.label).toBe("Weekly (7d)");
  expect(m[0]!.used).toBe(100);
  expect(m[0]!.resetAt).toBe(new Date(1785266702 * 1000).toISOString());
});

test("5h window and empty payloads", () => {
  expect(parseUsage({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } })[0]!.label).toBe(
    "Session (5h)",
  );
  expect(parseUsage({})).toEqual([]);
});
