import type { AgentKind, RawUsageRow, TokenUsage, UsageSourceId } from "./types.js";

export const emptyTokens = (): TokenUsage => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});

export const number = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const isoTimestamp = (value: unknown): string | undefined => {
  if (value == null || value === "") return undefined;
  let input: string | number = value as string | number;
  if (typeof input === "string" && /^\d+(?:\.\d+)?$/.test(input)) input = Number(input);
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return undefined;
    // Local stores vary between Unix seconds, milliseconds and microseconds.
    if (input < 100_000_000_000) input *= 1_000;
    else if (input > 100_000_000_000_000) input /= 1_000;
  }
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const recordTimestamp = (record: any): string | undefined =>
  isoTimestamp(record?.timestamp ?? record?.time ?? record?.created_at ?? record?.createdAt);

export const totalOf = (row: Pick<RawUsageRow, "input" | "cacheRead" | "cacheWrite" | "output">) =>
  row.input + row.cacheRead + row.cacheWrite + row.output;

export const contextReusePctOf = (
  row: Pick<RawUsageRow, "input" | "cacheRead" | "cacheWrite">,
): number | null => {
  const context = row.input + row.cacheRead + row.cacheWrite;
  return context > 0 ? Math.round(row.cacheRead / context * 1_000) / 10 : null;
};

export const addRaw = (target: RawUsageRow, source: RawUsageRow) => {
  target.calls += source.calls;
  target.input += source.input;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  if (source.cacheWrite5m != null) {
    target.cacheWrite5m = number(target.cacheWrite5m) + number(source.cacheWrite5m);
  }
  if (source.cacheWrite1h != null) {
    target.cacheWrite1h = number(target.cacheWrite1h) + number(source.cacheWrite1h);
  }
  target.output += source.output;
  target.reasoning += source.reasoning;
  if (source.recordedCostUsd != null) {
    target.recordedCostUsd = number(target.recordedCostUsd) + source.recordedCostUsd;
  }
};

export const rawRow = (
  source: UsageSourceId,
  model: string,
  effort: string,
  agent: AgentKind,
): RawUsageRow => ({
  source,
  model: model || "unknown",
  effort: effort || "default",
  agent,
  calls: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});
