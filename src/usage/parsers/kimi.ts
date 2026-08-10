import { lines } from "../files.js";
import { number, rawRow, recordTimestamp } from "../rows.js";
import type { AgentKind, RawUsageRow } from "../types.js";

export function parseKimiRecords(records: string[], agent: AgentKind = "main"): RawUsageRow[] {
  let model = "unknown";
  let effort = "default";
  const rows: RawUsageRow[] = [];
  for (const line of records) {
    if (!line.includes('"llm.request"') && !line.includes('"usage.record"')) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "llm.request") {
      model = String(record.modelAlias ?? record.model ?? model);
      effort = String(record.thinkingEffort ?? effort);
      continue;
    }
    if (record.type !== "usage.record" || !record.usage) continue;
    const usage = record.usage;
    const row = rawRow("kimi", String(record.model ?? model), effort, agent);
    row.calls = 1;
    row.input = number(usage.inputOther ?? usage.input);
    row.cacheRead = number(usage.inputCacheRead);
    row.cacheWrite = number(usage.inputCacheCreation);
    row.output = number(usage.output);
    row.reasoning = number(usage.outputReasoning ?? usage.reasoning);
    const recordedAt = recordTimestamp(record);
    if (recordedAt) row.recordedAt = recordedAt;
    rows.push(row);
  }
  return rows;
}

export async function scanKimi(path: string): Promise<RawUsageRow[]> {
  const selected: string[] = [];
  for await (const line of lines(path)) {
    if (line.includes('"llm.request"') || line.includes('"usage.record"')) selected.push(line);
  }
  const agent = /[\\/]agents[\\/](?:main)[\\/]/i.test(path) ? "main" : "subagent";
  return parseKimiRecords(selected, agent);
}
