import { lines } from "../files.js";
import { number, rawRow, recordTimestamp, totalOf } from "../rows.js";
import type { RawUsageRow } from "../types.js";

export interface ClaudeMessage {
  id: string;
  row: RawUsageRow;
}

export function parseClaudeRecords(records: string[], subagentFile = false): ClaudeMessage[] {
  const messages = new Map<string, RawUsageRow>();
  for (const line of records) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = record.message?.usage;
    const id = record.message?.id;
    if (record.type !== "assistant" || !usage || !id) continue;

    const cache5m = number(usage.cache_creation?.ephemeral_5m_input_tokens);
    const cache1h = number(usage.cache_creation?.ephemeral_1h_input_tokens);
    const cacheWrite = number(usage.cache_creation_input_tokens);
    const speed = usage.speed === "fast" ? " · fast" : "";
    const row = rawRow(
      "claude",
      String(record.message?.model ?? "unknown"),
      String(record.effort ?? "default") + speed,
      record.isSidechain || record.agentId || subagentFile ? "subagent" : "main",
    );
    row.calls = 1;
    row.input = number(usage.input_tokens);
    row.cacheRead = number(usage.cache_read_input_tokens);
    row.cacheWrite = cacheWrite;
    row.cacheWrite5m = cache5m || Math.max(0, cacheWrite - cache1h);
    row.cacheWrite1h = cache1h;
    row.output = number(usage.output_tokens);
    row.reasoning = number(usage.reasoning_tokens ?? usage.thinking_tokens);
    const recordedAt = recordTimestamp(record);
    if (recordedAt) row.recordedAt = recordedAt;

    const old = messages.get(String(id));
    if (!old || totalOf(row) >= totalOf(old)) messages.set(String(id), row);
  }
  return [...messages].map(([id, row]) => ({ id, row }));
}

export async function scanClaude(path: string): Promise<ClaudeMessage[]> {
  const selected: string[] = [];
  for await (const line of lines(path)) {
    if (line.includes('"assistant"') && line.includes('"usage"')) selected.push(line);
  }
  return parseClaudeRecords(selected, /[\\/]subagents[\\/]/i.test(path));
}
