import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage, type UsagePaths } from "./usage.js";

const message = (info: Record<string, unknown>) => JSON.stringify(info);

/**
 * NikCLI stores one row per message and, unlike OpenCode, records no cost, so the ledger
 * has to price its rows from the public list. Its `total` already contains the cache
 * counters, so only the four component fields may be read.
 */
async function fixture(): Promise<{ paths: UsagePaths; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "llm-quota-nikcli-"));
  const path = join(root, "nikcli.db");
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE session_info (id TEXT PRIMARY KEY, parent_id TEXT)");
  db.run("CREATE TABLE message_info (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, info TEXT)");
  db.run("INSERT INTO session_info VALUES ('ses-main', NULL), ('ses-child', 'ses-main')");
  db.run(
    "INSERT INTO message_info VALUES ('m1', 'ses-main', 'assistant', ?), ('m2', 'ses-child', 'assistant', ?), ('m3', 'ses-main', 'user', ?)",
    [
      message({
        modelID: "gpt-5.6-sol",
        providerID: "openai",
        cost: 0,
        tokens: { total: 30_605, input: 379, output: 18, reasoning: 0, cache: { write: 0, read: 30_208 } },
        time: { created: 1_785_344_840_257 },
      }),
      message({
        modelID: "glm-5.2",
        providerID: "zai-coding-plan",
        cost: 0,
        tokens: { total: 1_100, input: 1_000, output: 100, reasoning: 40, cache: { write: 0, read: 0 } },
        time: { created: 1_785_344_900_000 },
      }),
      message({ tokens: { total: 5, input: 5, output: 0, reasoning: 0, cache: { write: 0, read: 0 } } }),
    ],
  );
  db.close();

  return {
    root,
    paths: {
      codex: join(root, "codex"),
      claude: join(root, "claude"),
      kimi: join(root, "kimi"),
      opencodeDb: join(root, "missing.db"),
      pi: join(root, "pi"),
      prime: join(root, "prime"),
      nikcliDb: path,
    },
  };
}

test("NikCLI assistant messages enter the ledger with cache counters and delegation", async () => {
  const { paths, root } = await fixture();
  try {
    const summary = await collectUsage(paths);

    expect(summary.sources.find((source) => source.id === "nikcli")?.status).toBe("ok");
    // The user row carries no assistant usage and is never counted.
    expect(summary.tokens.total).toBe(30_605 + 1_100);
    expect(summary.tokens.cacheRead).toBe(30_208);

    const rows = summary.rows.filter((row) => row.source === "nikcli");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.model === "GPT-5.6 Sol")?.agent).toBe("main");
    expect(rows.find((row) => row.model === "GLM-5.2")?.agent).toBe("subagent");
    // Priced from the public list, since NikCLI records no cost of its own.
    expect(rows.every((row) => row.costBasis === "public_list")).toBe(true);
    expect(summary.daily.map((day) => day.date)).toEqual(["2026-07-29"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing NikCLI database is reported without taking the scan down", async () => {
  const { paths, root } = await fixture();
  try {
    const summary = await collectUsage({ ...paths, nikcliDb: join(root, "absent.db") });
    expect(summary.sources.find((source) => source.id === "nikcli")?.status).toBe("missing");
    expect(summary.tokens.total).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
