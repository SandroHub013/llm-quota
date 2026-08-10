import { lines } from "../files.js";
import { number, rawRow, recordTimestamp } from "../rows.js";
import type { AgentKind, RawUsageRow } from "../types.js";

/**
 * pi and Prime Agent write the same versioned session log: a `session` header, then
 * `model_change` and `thinking_level_change` records that stay in force until the next
 * one, then one `message` record per turn carrying the assistant usage. `input` excludes
 * both cache counters and `reasoning` is a subset of `output`, matching the other sources.
 */
export function parsePiRecords(
  records: string[],
  source: "pi" | "prime",
  agent: AgentKind = "main",
): RawUsageRow[] {
  let model = "unknown";
  let effort = "default";
  let kind = agent;
  const rows: RawUsageRow[] = [];
  for (const line of records) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "session") {
      // A delegated run names the transcript that spawned it and sits below its depth.
      if (record.parentSession || number(record.rlmDepth) > 0) kind = "subagent";
      continue;
    }
    if (record.type === "model_change") {
      model = String(record.modelId ?? model);
      continue;
    }
    if (record.type === "thinking_level_change") {
      effort = String(record.thinkingLevel ?? effort);
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message;
    const usage = message?.usage;
    if (message?.role !== "assistant" || !usage) continue;

    const row = rawRow(source, String(message.model ?? model), effort, kind);
    row.calls = 1;
    row.input = number(usage.input);
    row.cacheRead = number(usage.cacheRead);
    row.cacheWrite = number(usage.cacheWrite);
    row.output = number(usage.output);
    row.reasoning = number(usage.reasoning);
    const cost = number(usage.cost?.total);
    if (cost > 0) row.recordedCostUsd = cost;
    const recordedAt = recordTimestamp(record);
    if (recordedAt) row.recordedAt = recordedAt;
    rows.push(row);
  }
  return rows;
}

export async function scanPi(path: string, source: "pi" | "prime"): Promise<RawUsageRow[]> {
  const selected: string[] = [];
  for await (const line of lines(path)) {
    if (line.includes('"usage"') || line.includes('_change"') || line.includes('"session"')) {
      selected.push(line);
    }
  }
  // Prime files under a `sub-<id>` artifact directory are delegated runs even when the
  // transcript was truncated before its own session header was written.
  const delegated = /[\\/]sub-[^\\/]+[\\/][^\\/]+\.jsonl$/i.test(path);
  return parsePiRecords(selected, source, delegated ? "subagent" : "main");
}
