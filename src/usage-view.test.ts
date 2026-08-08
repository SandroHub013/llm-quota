import { expect, test } from "bun:test";
import { summarizeUsageRows, USAGE_SOURCE_IDS, type RawUsageRow } from "./usage.js";
import {
  DEFAULT_USAGE_VIEW,
  normalizeUsageView,
  usageFiltersActive,
  usageHeadlineCosts,
} from "./usage-view.js";

const row = (overrides: Partial<RawUsageRow>): RawUsageRow => ({
  source: "claude",
  model: "claude-opus-5",
  effort: "default",
  agent: "main",
  calls: 1,
  input: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  ...overrides,
});

const summary = summarizeUsageRows([
  row({ source: "claude", agent: "main" }),
  row({ source: "codex", model: "gpt-5.6-sol", agent: "subagent" }),
]);

test("unknown or hand-edited view values fall back to all", () => {
  expect(normalizeUsageView(undefined)).toEqual(DEFAULT_USAGE_VIEW);
  expect(normalizeUsageView({ source: "evil", agent: 42 })).toEqual(DEFAULT_USAGE_VIEW);
  expect(normalizeUsageView({ source: "claude", agent: "subagent" })).toEqual({
    source: "claude",
    agent: "subagent",
  });
});

test("the default view means no filtering", () => {
  expect(usageFiltersActive(DEFAULT_USAGE_VIEW)).toBe(false);
  expect(usageFiltersActive({ source: "all", agent: "main" })).toBe(true);
  expect(usageFiltersActive({ source: "kimi", agent: "all" })).toBe(true);
});

test("the unfiltered headline is the untouched grand total", () => {
  const headline = usageHeadlineCosts(summary, DEFAULT_USAGE_VIEW);
  expect(headline.usd).toBe(summary.estimatedCostUsd);
  expect(headline.eur).toBe(summary.estimatedCostEur);
});

test("a filtered headline sums only the visible rows, like the dashboard", () => {
  // claude main: 1M input at $5/M = $5; codex subagent: 1M input at $5/M = $5.
  expect(usageHeadlineCosts(summary, { source: "all", agent: "main" }).usd).toBeCloseTo(5, 10);
  expect(usageHeadlineCosts(summary, { source: "all", agent: "subagent" }).usd).toBeCloseTo(5, 10);
  expect(usageHeadlineCosts(summary, { source: "claude", agent: "all" }).usd).toBeCloseTo(5, 10);
  expect(usageHeadlineCosts(summary, { source: "kimi", agent: "all" }).usd).toBe(0);
  expect(usageHeadlineCosts(summary, { source: "all", agent: "main" }).eur)
    .toBeCloseTo(5 / 1.1485, 10);
});

test("a ledger source added to the scanner is selectable in the shared view", () => {
  for (const source of USAGE_SOURCE_IDS) {
    expect(normalizeUsageView({ source, agent: "all" }).source).toBe(source);
  }
});
