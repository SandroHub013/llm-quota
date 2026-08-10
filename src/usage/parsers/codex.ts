import { basename } from "node:path";
import { lines } from "../files.js";
import { number, rawRow, recordTimestamp } from "../rows.js";
import type { AgentKind, CodexFileUsage, RawUsageRow } from "../types.js";

function codexAgent(payload: any): AgentKind {
  return payload?.thread_source === "subagent" || payload?.source?.subagent ? "subagent" : "main";
}

export function parseCodexRecords(records: string[], fallbackId = "session"): CodexFileUsage {
  let sessionId = fallbackId;
  let model = "unknown";
  let effort = "default";
  let agent: AgentKind = "main";
  let previous: Record<string, number> | undefined;
  const grouped = new Map<string, RawUsageRow>();

  for (const line of records) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) {
      continue;
    }
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === "session_meta") {
      sessionId = String(record.payload?.session_id ?? record.payload?.id ?? sessionId);
      agent = codexAgent(record.payload);
      continue;
    }
    if (record.type === "turn_context") {
      model = String(record.payload?.model ?? model);
      effort = String(record.payload?.effort ?? effort);
      continue;
    }
    if (record.type !== "event_msg" || record.payload?.type !== "token_count") continue;

    const usage = record.payload?.info?.total_token_usage;
    if (!usage) continue;
    const current: Record<string, number> = {
      input_tokens: number(usage.input_tokens),
      cached_input_tokens: number(usage.cached_input_tokens),
      cache_write_input_tokens: number(usage.cache_write_input_tokens),
      output_tokens: number(usage.output_tokens),
      reasoning_output_tokens: number(usage.reasoning_output_tokens),
    };
    const reset = previous && Object.keys(current).some((key) => current[key]! < number(previous?.[key]));
    const delta = Object.fromEntries(
      Object.entries(current).map(([key, value]) => [key, Math.max(0, value - (reset ? 0 : number(previous?.[key])))]),
    );
    previous = current;
    if (Object.values(delta).every((value) => value === 0)) continue;

    const recordedAt = recordTimestamp(record);
    const key = `${model}\u0000${effort}\u0000${agent}\u0000${recordedAt?.slice(0, 10) ?? "undated"}`;
    const row = grouped.get(key) ?? rawRow("codex", model, effort, agent);
    if (recordedAt && !row.recordedAt) row.recordedAt = recordedAt;
    const cacheRead = number(delta.cached_input_tokens);
    const cacheWrite = number(delta.cache_write_input_tokens);
    row.calls += 1;
    row.cacheRead += cacheRead;
    row.cacheWrite += cacheWrite;
    row.input += Math.max(0, number(delta.input_tokens) - cacheRead - cacheWrite);
    row.output += number(delta.output_tokens);
    row.reasoning += number(delta.reasoning_output_tokens);
    grouped.set(key, row);
  }
  return { sessionId, rows: [...grouped.values()] };
}

export async function scanCodex(path: string): Promise<CodexFileUsage> {
  const selected: string[] = [];
  for await (const line of lines(path)) {
    if (line.includes('"session_meta"') || line.includes('"turn_context"') || line.includes('"token_count"')) {
      selected.push(line);
    }
  }
  return parseCodexRecords(selected, basename(path));
}
