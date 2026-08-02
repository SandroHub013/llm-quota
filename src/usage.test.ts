import { expect, test } from "bun:test";
import {
  parseClaudeRecords,
  parseCodexRecords,
  parseKimiRecords,
  summarizeUsageRows,
  type RawUsageRow,
} from "./usage.js";

const line = (value: unknown) => JSON.stringify(value);

test("Codex totals are converted to deltas and keep model, effort, and subagent detail", () => {
  const records = [
    line({
      type: "session_meta",
      payload: { id: "thread-1", thread_source: "subagent" },
    }),
    line({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "max" } }),
    line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 200,
            cache_write_input_tokens: 100,
            output_tokens: 100,
            reasoning_output_tokens: 20,
          },
        },
      },
    }),
    // A repeated snapshot is not another model call.
    line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 200,
            cache_write_input_tokens: 100,
            output_tokens: 100,
            reasoning_output_tokens: 20,
          },
        },
      },
    }),
    line({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1_500,
            cached_input_tokens: 300,
            cache_write_input_tokens: 100,
            output_tokens: 150,
            reasoning_output_tokens: 30,
          },
        },
      },
    }),
  ];

  expect(parseCodexRecords(records)).toEqual({
    sessionId: "thread-1",
    rows: [{
      source: "codex",
      model: "gpt-5.6-sol",
      effort: "max",
      agent: "subagent",
      calls: 2,
      input: 1_100,
      cacheRead: 300,
      cacheWrite: 100,
      output: 150,
      reasoning: 30,
    }],
  });
});

test("Claude streaming duplicates are counted once with cache duration and effort", () => {
  const assistant = (output: number) => line({
    type: "assistant",
    isSidechain: true,
    effort: "xhigh",
    message: {
      id: "msg-1",
      model: "claude-opus-5",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_creation: {
          ephemeral_5m_input_tokens: 5,
          ephemeral_1h_input_tokens: 25,
        },
        output_tokens: output,
        speed: "standard",
      },
    },
  });

  const messages = parseClaudeRecords([assistant(5), assistant(7)]);

  expect(messages).toHaveLength(1);
  expect(messages[0]).toEqual({
    id: "msg-1",
    row: {
      source: "claude",
      model: "claude-opus-5",
      effort: "xhigh",
      agent: "subagent",
      calls: 1,
      input: 10,
      cacheRead: 20,
      cacheWrite: 30,
      cacheWrite5m: 5,
      cacheWrite1h: 25,
      output: 7,
      reasoning: 0,
    },
  });
  const expectedUsd = (10 * 5 + 20 * 0.5 + 5 * 6.25 + 25 * 10 + 7 * 25) / 1_000_000;
  expect(summarizeUsageRows(messages.map((message) => message.row)).estimatedCostUsd).toBeCloseTo(
    expectedUsd,
    10,
  );
});

test("Kimi usage records inherit request effort and expose cache tokens", () => {
  const rows = parseKimiRecords([
    line({
      type: "llm.request",
      model: "k3",
      modelAlias: "kimi-code/k3",
      thinkingEffort: "high",
    }),
    line({
      type: "usage.record",
      model: "kimi-code/k3",
      usage: { inputOther: 10, inputCacheRead: 20, inputCacheCreation: 5, output: 7 },
    }),
  ], "subagent");

  expect(rows[0]).toMatchObject({
    source: "kimi",
    model: "kimi-code/k3",
    effort: "high",
    agent: "subagent",
    input: 10,
    cacheRead: 20,
    cacheWrite: 5,
    output: 7,
  });
});

test("the summary prices cache separately and does not double-count reasoning", () => {
  const rows: RawUsageRow[] = [{
    source: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    agent: "main",
    calls: 1,
    input: 1_000_000,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_000,
    reasoning: 400_000,
  }, {
    source: "opencode",
    model: "private-model",
    effort: "default",
    agent: "main",
    calls: 1,
    input: 100,
    cacheRead: 0,
    cacheWrite: 0,
    output: 50,
    reasoning: 25,
  }];

  const summary = summarizeUsageRows(rows);

  expect(summary.estimatedCostUsd).toBe(41.75);
  expect(summary.estimatedCostEur).toBeCloseTo(41.75 / 1.1485);
  expect(summary.tokens).toEqual({
    input: 1_000_100,
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    output: 1_000_050,
    reasoning: 400_025,
    total: 4_000_150,
  });
  expect(summary.pricedTokens).toBe(4_000_000);
  expect(summary.unpricedModels).toEqual(["private-model"]);
});

test("context reuse measures cached context globally and per model", () => {
  const rows: RawUsageRow[] = [{
    source: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    agent: "main",
    calls: 1,
    input: 600,
    cacheRead: 300,
    cacheWrite: 100,
    output: 1_000,
    reasoning: 900,
  }, {
    source: "claude",
    model: "claude-opus-5",
    effort: "xhigh",
    agent: "subagent",
    calls: 1,
    input: 0,
    cacheRead: 100,
    cacheWrite: 0,
    output: 20,
    reasoning: 0,
  }, {
    source: "opencode",
    model: "output-only",
    effort: "default",
    agent: "main",
    calls: 1,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 10,
    reasoning: 10,
  }];

  const summary = summarizeUsageRows(rows);

  // 400 cached tokens out of 1,100 total context tokens. Output and reasoning
  // deliberately do not affect this resource-efficiency index.
  expect(summary.contextReusePct).toBe(36.4);
  expect(summary.rows.find((row) => row.model === "GPT-5.6 Sol")?.contextReusePct).toBe(30);
  expect(summary.rows.find((row) => row.model === "Claude Opus 5")?.contextReusePct).toBe(100);
  expect(summary.rows.find((row) => row.model === "output-only")?.contextReusePct).toBeNull();
});
