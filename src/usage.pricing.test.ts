/**
 * The arithmetic behind the headline figure.
 *
 * This is the number the dashboard puts in the largest type it owns, and the one the
 * widget carries in a status bar. It is also the number nobody can check by looking: a
 * cache write billed at the five-minute rate instead of the hour rate, or an alias that
 * misses its price and quietly contributes nothing, produces a total that is wrong and
 * confident. Everything here is a fixed input with a cost worked out by hand.
 *
 * Rates, per million tokens, from the list this ledger is priced against:
 *   claude-opus-5   input 5    cache read 0.5   cache write 6.25 (5m) / 10 (1h)   output 25
 *   gpt-5.6-sol     input 5    cache read 0.5   cache write 6.25                  output 30
 *   USD per EUR 1.1485
 */
import { expect, test } from "bun:test";
import { summarizeUsageRows, type RawUsageRow } from "./usage.js";

const USD_PER_EUR = 1.1485;
const M = 1_000_000;

const row = (over: Partial<RawUsageRow> = {}): RawUsageRow => ({
  source: "claude",
  model: "claude-opus-5",
  effort: "high",
  agent: "main",
  calls: 1,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  ...over,
});

/**
 * A one-hour cache write costs twice a five-minute one. The sources record the total
 * and, when they know it, the hour share; the rest is five-minute. Getting this
 * backwards misprices the largest column in the ledger — cache write is where a coding
 * session's tokens actually go.
 */
test("cache writes are split between the five-minute rate and the hour rate", () => {
  const summary = summarizeUsageRows([row({ cacheWrite: M, cacheWrite1h: 0.4 * M })]);

  // 600k at 6.25 + 400k at 10.
  expect(summary.estimatedCostUsd).toBeCloseTo(3.75 + 4, 10);
  expect(summary.rows[0]!.costEur).toBeCloseTo(7.75 / USD_PER_EUR, 10);
});

test("a source that records both shares is believed, not recomputed", () => {
  // 250k five-minute and 400k hour out of a million: the remainder was written by a
  // request this row does not account for, and inventing it would overcharge.
  const summary = summarizeUsageRows([row({ cacheWrite: M, cacheWrite5m: 0.25 * M, cacheWrite1h: 0.4 * M })]);

  expect(summary.estimatedCostUsd).toBeCloseTo(1.5625 + 4, 10);
  // The token total still counts every written token, priced or not.
  expect(summary.tokens.cacheWrite).toBe(M);
});

test("a write with no hour share is all five-minute", () => {
  const summary = summarizeUsageRows([row({ cacheWrite: M })]);

  expect(summary.estimatedCostUsd).toBeCloseTo(6.25, 10);
});

/**
 * Fast mode is a different price list for the same model, and it arrives as a word in
 * the effort rather than as a different model id. Missing it halves the bill for the
 * most expensive way to use the most expensive model.
 */
test("fast mode is priced as fast mode", () => {
  const standard = summarizeUsageRows([row({ input: M, output: M })]);
  const fast = summarizeUsageRows([row({ input: M, output: M, effort: "high fast" })]);

  expect(standard.estimatedCostUsd).toBeCloseTo(5 + 25, 10);
  expect(fast.estimatedCostUsd).toBeCloseTo(10 + 50, 10);
});

// Opus 4.7 has no fast mode at the 4.8 price; it has its own, six times the standard.
test("each model that has a fast rate uses its own", () => {
  const summary = summarizeUsageRows([
    row({ model: "claude-opus-4-7", input: M, output: M, effort: "fast" }),
  ]);

  expect(summary.estimatedCostUsd).toBeCloseTo(30 + 150, 10);
});

/**
 * A free model is priced, at zero. The distinction matters: unpriced means "this total
 * is missing something", zero means "this cost nothing" — and the coverage percentage
 * the dashboard shows is built on which one it is.
 */
test("a free model costs nothing and still counts as priced", () => {
  const summary = summarizeUsageRows([
    row({ source: "opencode", model: "some-local-model-free", input: 5 * M, output: M }),
  ]);

  expect(summary.estimatedCostUsd).toBe(0);
  expect(summary.unpricedModels).toEqual([]);
  expect(summary.pricingCoveragePct).toBe(100);
  expect(summary.rows[0]!.costBasis).toBe("public_list");
});

/**
 * When the list has no price, a cost the source recorded itself is used instead — and
 * labelled, because the two are not the same claim. OpenCode and NikCLI are the sources
 * that carry one.
 */
test("a model off the list falls back to the cost its source recorded", () => {
  const summary = summarizeUsageRows([
    row({ source: "opencode", model: "some-private-model", input: M, output: M, recordedCostUsd: 3 }),
  ]);

  expect(summary.estimatedCostUsd).toBe(3);
  expect(summary.rows[0]!.costBasis).toBe("recorded");
  // Priced, so it is not reported as a hole in the total.
  expect(summary.unpricedModels).toEqual([]);
  expect(summary.pricingCoveragePct).toBe(100);
});

test("a model off the list with no recorded cost is reported as a hole", () => {
  const summary = summarizeUsageRows([
    row({ source: "opencode", model: "some-private-model", input: M, output: M }),
    row({ input: M, output: M }),
  ]);

  expect(summary.estimatedCostUsd).toBeCloseTo(30, 10);
  expect(summary.unpricedModels).toEqual(["some-private-model"]);
  // Half the tokens carry a price, and the dashboard says so rather than implying the
  // total is complete.
  expect(summary.pricingCoveragePct).toBe(50);
  expect(summary.rows.find((entry) => entry.model === "some-private-model")!.costUsd).toBeUndefined();
});

/**
 * The same model reaches this ledger under several names: a dated snapshot id, a
 * provider-prefixed path, a vendor's short form. A name that misses its price is not an
 * error anywhere — it is simply a row that stops contributing to the total.
 */
test("the names one model arrives under all reach the same price", () => {
  for (const [model, expected] of [
    ["claude-opus-5-20260101", "Claude Opus 5"],
    ["anthropic/claude-opus-5", "Claude Opus 5"],
    ["gpt-5.6", "GPT-5.6 Sol"],
    ["openai/gpt-5.5", "GPT-5.5"],
    ["moonshotai/kimi-k2.7-code", "Kimi K2.7 Code"],
    ["k3", "Kimi K3"],
  ] as const) {
    const summary = summarizeUsageRows([row({ model, input: M })]);

    expect(summary.rows[0]!.model, `${model} was not recognised`).toBe(expected);
    expect(summary.unpricedModels, `${model} was not priced`).toEqual([]);
    expect(summary.estimatedCostUsd).toBeGreaterThan(0);
  }
});

/**
 * Rows are grouped by what the table shows: source, model, effort, agent. Two calls at
 * the same settings are one line with two calls; a change of effort is a different line,
 * because it can be a different price.
 */
test("identical settings merge into one line, and effort splits it", () => {
  const summary = summarizeUsageRows([
    row({ input: M }),
    row({ input: M }),
    row({ input: M, effort: "low" }),
  ]);

  expect(summary.rows).toHaveLength(2);
  const high = summary.rows.find((entry) => entry.effort === "high")!;
  expect(high.calls).toBe(2);
  expect(high.input).toBe(2 * M);
  expect(high.costUsd).toBeCloseTo(10, 10);
  expect(summary.estimatedCostUsd).toBeCloseTo(15, 10);
});

/**
 * Reasoning is billed inside output by every log format this reads. Adding it to the
 * total would inflate both the token count and, through the coverage percentage, the
 * confidence in the euro figure beside it.
 */
test("reasoning is inside output and never charged twice", () => {
  const summary = summarizeUsageRows([row({ output: M, reasoning: 0.8 * M })]);

  expect(summary.estimatedCostUsd).toBeCloseTo(25, 10);
  expect(summary.tokens.total).toBe(M);
  expect(summary.tokens.reasoning).toBe(0.8 * M);
});

test("euros are the dollars, converted once, at the rate the summary publishes", () => {
  const summary = summarizeUsageRows([row({ input: M, output: M })]);

  expect(summary.pricing.usdPerEur).toBe(USD_PER_EUR);
  expect(summary.estimatedCostEur).toBeCloseTo(summary.estimatedCostUsd / USD_PER_EUR, 10);
  expect(summary.currency).toBe("EUR");
  // The label the dashboard prints under the figure: an estimate of API-equivalent
  // value, not a bill anyone received.
  expect(summary.pricing.kind).toBe("api_equivalent");
});

/**
 * The two rates an external catalogue caught this table getting wrong: Terra was priced a
 * quarter high and Luna five times high, for months, against a vendor page that said 2/12
 * and 0.20/1.20. Pinned here so the numbers are visible where someone reads the maths,
 * and so putting them back is a deliberate act. `bun run prices:check` is what would
 * notice a vendor moving them again.
 */
test("the OpenAI family is priced at the list, not near it", () => {
  const terra = summarizeUsageRows([row({ source: "codex", model: "gpt-5.6-terra", input: M, output: M })]);
  expect(terra.estimatedCostUsd).toBeCloseTo(2 + 12, 10);

  const luna = summarizeUsageRows([row({ source: "codex", model: "gpt-5.6-luna", input: M, output: M })]);
  expect(luna.estimatedCostUsd).toBeCloseTo(0.2 + 1.2, 10);

  // Cache reads are a tenth of input on this family, which is what makes a long session
  // affordable — and what makes getting the input rate wrong expensive.
  const cached = summarizeUsageRows([row({ source: "codex", model: "gpt-5.6-luna", cacheRead: 10 * M })]);
  expect(cached.estimatedCostUsd).toBeCloseTo(0.2, 10);
});

/**
 * MiniMax is the plan this project can price but cannot yet read: its Coding Plan covers
 * these models, and what the ledger reports is what the same tokens would have cost
 * through the API. Highspeed is the same model on a faster tier at twice the rate, which
 * is the pair most likely to be mixed up.
 */
test("MiniMax models are priced, and highspeed costs twice standard", () => {
  const standard = summarizeUsageRows([
    row({ source: "opencode", model: "MiniMax-M2.7", input: M, output: M }),
  ]);
  const highspeed = summarizeUsageRows([
    row({ source: "opencode", model: "MiniMax-M2.7-highspeed", input: M, output: M }),
  ]);

  expect(standard.estimatedCostUsd).toBeCloseTo(0.3 + 1.2, 10);
  expect(highspeed.estimatedCostUsd).toBeCloseTo(0.6 + 2.4, 10);
  // Named as the vendor writes it, whatever case the CLI logged.
  expect(standard.rows[0]!.model).toBe("MiniMax M2.7");
  expect(standard.unpricedModels).toEqual([]);
});

test("no rows is zero, not a division by zero", () => {
  const summary = summarizeUsageRows([]);

  expect(summary.estimatedCostUsd).toBe(0);
  expect(summary.estimatedCostEur).toBe(0);
  expect(summary.pricingCoveragePct).toBe(0);
  expect(summary.contextReusePct).toBeNull();
});
