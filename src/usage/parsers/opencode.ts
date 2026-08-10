import { existsSync } from "node:fs";
import { isoTimestamp, number, rawRow } from "../rows.js";
import type { RawUsageRow } from "../types.js";

export async function scanOpenCode(path: string): Promise<RawUsageRow[]> {
  if (!existsSync(path) || typeof Bun === "undefined") return [];
  const { Database } = await import("bun:sqlite");
  const db = new Database(path, { readonly: true });
  try {
    const sessions = db.query(`
      SELECT parent_id, model, cost, tokens_input, tokens_output, tokens_reasoning,
             tokens_cache_read, tokens_cache_write, time_created
      FROM session
    `).all() as Record<string, unknown>[];
    return sessions.map((session) => {
      let metadata: any = {};
      try {
        metadata = JSON.parse(String(session.model ?? "{}"));
      } catch {}
      const row = rawRow(
        "opencode",
        String(metadata.id ?? "unknown"),
        String(metadata.variant ?? "default"),
        session.parent_id ? "subagent" : "main",
      );
      row.calls = 1;
      row.input = number(session.tokens_input);
      row.cacheRead = number(session.tokens_cache_read);
      row.cacheWrite = number(session.tokens_cache_write);
      row.reasoning = number(session.tokens_reasoning);
      // OpenCode stores visible output and reasoning separately. Normalize output
      // to the other sources, where reasoning is a subset of billed output.
      row.output = number(session.tokens_output) + row.reasoning;
      if (number(session.cost) > 0) row.recordedCostUsd = number(session.cost);
      const recordedAt = isoTimestamp(session.time_created);
      if (recordedAt) row.recordedAt = recordedAt;
      return row;
    });
  } finally {
    db.close();
  }
}
