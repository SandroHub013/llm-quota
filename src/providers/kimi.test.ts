import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { fetchKimiQuota, parseKimiUsages } from "./kimi.js";

const RESET = 1_787_000_000;

test("Kimi usages map becomes 5h, weekly and monthly metrics", () => {
  const metrics = parseKimiUsages({
    usages: {
      limit_5h: { used_ratio: 0.2, reset_time: RESET },
      limit_7d: { used_ratio: 0.34, reset_time: RESET + 86_400 },
      limit_month_total: { used_ratio: 0.5 },
    },
  });

  expect(metrics.map((metric) => [metric.label, metric.used, metric.remaining])).toEqual([
    ["Session (5h)", 20, 80],
    ["Weekly (7d)", 34, 66],
    ["Monthly", 50, 50],
  ]);
  expect(metrics[0]!.resetAt).toBe(new Date(RESET * 1000).toISOString());
});

test("a single usage object is the weekly window", () => {
  const metrics = parseKimiUsages({ usage: { used: 10, limit: 100, remaining: 90 } });
  expect(metrics).toEqual([
    { label: "Weekly (7d)", used: 10, limit: 100, remaining: 90, unit: "percent", resetAt: undefined },
  ]);
});

test("an empty Kimi payload is no metrics", () => {
  expect(parseKimiUsages(undefined)).toEqual([]);
  expect(parseKimiUsages({})).toEqual([]);
});

const originalHome = process.env.KIMI_HOME;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "llm-quota-kimi-"));
  process.env.KIMI_HOME = join(tempDir, ".kimi-code");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.KIMI_HOME;
  else process.env.KIMI_HOME = originalHome;
  rmSync(tempDir, { recursive: true, force: true });
});

test("without a Kimi session the card asks to log in", async () => {
  const result = await fetchKimiQuota({}, tempDir);
  expect(result.status).toBe("unauthenticated");
  expect(result.needsKey).toBe(true);
  expect(result.metrics).toEqual([]);
});
