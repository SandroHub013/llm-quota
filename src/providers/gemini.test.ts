import { expect, test } from "bun:test";
import { parseQuota } from "./gemini.js";

test("official Antigravity status-line quota maps remaining fractions and resets", () => {
  const metrics = parseQuota({
    version: 1,
    provider: "antigravity",
    capturedAt: "2026-08-03T10:00:00Z",
    data: {
      quota: {
        "gemini-weekly": {
          remaining_fraction: 0.72,
          reset_time: "2026-08-09T10:00:00Z",
          reset_in_seconds: 123,
        },
      },
    },
  });
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({ label: "Gemini Weekly", used: 28, limit: 100, unit: "percent" });
  expect(metrics[0]!.resetAt).toBe("2026-08-09T10:00:00.000Z");
});

test("Antigravity buckets without numeric quota are ignored", () => {
  expect(parseQuota()).toEqual([]);
  expect(parseQuota({
    version: 1,
    provider: "antigravity",
    capturedAt: "2026-08-03T10:00:00Z",
    data: { quota: { future: {} } },
  })).toEqual([]);
});
