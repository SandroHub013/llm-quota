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

// "3p" is how Antigravity names the Claude/GPT pool; the raw key reads as noise.
test("the third-party pool gets a readable label and unknown buckets stay title case", () => {
  const metrics = parseQuota({
    version: 1,
    provider: "antigravity",
    capturedAt: "2026-08-03T10:00:00Z",
    data: {
      quota: {
        "3p-5h": { remaining_fraction: 1, reset_in_seconds: 60 },
        "3p-weekly": { remaining_fraction: 0.5, reset_in_seconds: 60 },
        "gemini-5h": { remaining_fraction: 0.9, reset_in_seconds: 60 },
        "future-bucket": { remaining_fraction: 0.8, reset_in_seconds: 60 },
      },
    },
  });
  expect(metrics.map((metric) => metric.label).sort()).toEqual([
    "Future Bucket",
    "Gemini 5h",
    "Third-party 5h",
    "Third-party Weekly",
  ]);
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

test("out-of-range relative reset timestamps do not break the metric", () => {
  const metrics = parseQuota({
    version: 1,
    provider: "antigravity",
    capturedAt: "2026-08-03T10:00:00Z",
    data: { quota: { future: { remaining_fraction: 0.5, reset_in_seconds: Number.MAX_VALUE } } },
  });
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({ label: "Future", used: 50, limit: 100 });
  expect(metrics[0]!.resetAt).toBeUndefined();
});
