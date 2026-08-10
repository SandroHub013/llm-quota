import { existsSync } from "node:fs";
import { isoTimestamp, number, rawRow } from "../rows.js";
import type { RawUsageRow } from "../types.js";

/**
 * NikCLI keeps one row per message in SQLite, with the token counters inside the JSON
 * `info` blob. Unlike OpenCode it never stores a cost, so every row is priced from the
 * public list instead.
 */
export async function scanNikcli(path: string): Promise<RawUsageRow[]> {
  if (!existsSync(path) || typeof Bun === "undefined") return [];
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { readonly: true });
  try {
    const messages = db.query(`
      SELECT message_info.info AS info, session_info.parent_id AS parent_id
      FROM message_info
      LEFT JOIN session_info ON session_info.id = message_info.session_id
      WHERE message_info.role = 'assistant'
    `).all() as Record<string, unknown>[];

    const rows: RawUsageRow[] = [];
    for (const message of messages) {
      let info: any;
      try {
        info = JSON.parse(String(message.info ?? "{}"));
      } catch {
        continue;
      }
      const tokens = info.tokens;
      if (!tokens) continue;
      const row = rawRow(
        "nikcli",
        String(info.modelID ?? "unknown"),
        "default",
        message.parent_id ? "subagent" : "main",
      );
      row.calls = 1;
      row.input = number(tokens.input);
      row.cacheRead = number(tokens.cache?.read);
      row.cacheWrite = number(tokens.cache?.write);
      row.output = number(tokens.output);
      row.reasoning = number(tokens.reasoning);
      if (number(info.cost) > 0) row.recordedCostUsd = number(info.cost);
      const recordedAt = isoTimestamp(info.time?.created);
      if (recordedAt) row.recordedAt = recordedAt;
      rows.push(row);
    }
    return rows;
  } finally {
    db.close();
  }
}
