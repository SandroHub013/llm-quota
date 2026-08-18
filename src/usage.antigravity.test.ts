import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage, type UsagePaths } from "./usage.js";

/**
 * Antigravity, the CLI launched as `agy`, keeps one SQLite file per conversation and
 * stores each request as a protobuf blob with no schema shipped alongside it. These
 * fixtures encode the wire format by hand, so the test fails the day the reader starts
 * guessing at field numbers instead of reading the ones observed on disk.
 */
const varint = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  do {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return out;
};

const uint = (field: number, value: number): number[] => [...varint(field * 8), ...varint(value)];

const bytes = (field: number, payload: number[]): number[] =>
  [...varint(field * 8 + 2), ...varint(payload.length), ...payload];

const text = (field: number, value: string): number[] =>
  bytes(field, [...new TextEncoder().encode(value)]);

interface Counters {
  input?: number;
  output?: number;
  cacheRead?: number;
  thinking?: number;
  visible?: number;
}

const record = (
  model: string,
  label: string,
  counters: Counters,
  seconds: number,
): Uint8Array => {
  const usage = [
    uint(1, 1_299),
    uint(2, counters.input ?? 0),
    uint(3, counters.output ?? 0),
    uint(5, counters.cacheRead ?? 0),
    // Field 6 is a constant the reader must skip rather than mistake for a counter.
    uint(6, 24),
    uint(9, counters.thinking ?? 0),
    uint(10, counters.visible ?? 0),
  ].flat();
  const generation = [
    bytes(4, usage),
    bytes(9, [...bytes(4, [...uint(1, seconds), ...uint(2, 323_394_200)])].flat()),
    text(19, model),
    text(20, "request_id"),
    text(21, label),
  ].flat();
  return new Uint8Array([
    // The record opens with fields the ledger has no use for, including a fixed64.
    ...uint(2, 2),
    ...text(4, "7080a78c-fd26-49c7-96c0-b573d8f4bd00"),
    ...[varint(3 * 8 + 1), [0, 0, 0, 0, 0, 0, 0, 0]].flat(),
    ...bytes(1, generation),
  ]);
};

const conversation = (path: string, blobs: Uint8Array[]) => {
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)");
  blobs.forEach((blob, idx) => {
    db.run("INSERT INTO gen_metadata VALUES (?, ?, ?)", [idx, blob, blob.length]);
  });
  db.close();
};

async function fixture(): Promise<{ paths: UsagePaths; root: string; conversations: string }> {
  const root = await mkdtemp(join(tmpdir(), "llm-quota-antigravity-"));
  const conversations = join(root, "conversations");
  await mkdir(conversations, { recursive: true });

  conversation(join(conversations, "a.db"), [
    record("gemini-3.7-flash", "Gemini 3.7 Flash (Medium)", {
      input: 19_149,
      output: 170,
      thinking: 85,
      visible: 85,
    }, 1_785_344_840),
    record("gemini-3.7-flash", "Gemini 3.7 Flash (Medium)", {
      input: 3_276,
      output: 41,
      cacheRead: 16_292,
      thinking: 23,
      visible: 18,
    }, 1_785_344_900),
    // A cancelled request leaves the record behind with every counter at zero.
    record("gemini-3.7-flash", "Gemini 3.7 Flash (Medium)", {}, 1_785_344_960),
  ]);

  // An internal A/B alias for a published model, at a different effort.
  conversation(join(conversations, "b.db"), [
    record("gemini-3-flash-a", "Gemini 3.5 Flash (High)", {
      input: 1_000,
      output: 100,
      cacheRead: 5_000,
      thinking: 60,
      visible: 40,
    }, 1_785_431_240),
  ]);

  return {
    root,
    conversations,
    paths: {
      codex: join(root, "codex"),
      claude: join(root, "claude"),
      kimi: join(root, "kimi"),
      opencodeDb: join(root, "missing.db"),
      pi: join(root, "pi"),
      prime: join(root, "prime"),
      nikcliDb: join(root, "missing-nikcli.db"),
      antigravity: conversations,
    },
  };
}

test("Antigravity conversations enter the ledger with effort, cache reads and thinking", async () => {
  const { paths, root } = await fixture();
  try {
    const summary = await collectUsage(paths);

    expect(summary.sources.find((source) => source.id === "antigravity")?.status).toBe("ok");
    expect(summary.sources.find((source) => source.id === "antigravity")?.files).toBe(2);

    const rows = summary.rows.filter((row) => row.source === "antigravity");
    // Two models, and the zero-token record is not one of them.
    expect(rows).toHaveLength(2);

    const flash = rows.find((row) => row.model === "Gemini 3.7 Flash")!;
    expect(flash.effort).toBe("medium");
    expect(flash.calls).toBe(2);
    expect(flash.input).toBe(19_149 + 3_276);
    expect(flash.cacheRead).toBe(16_292);
    expect(flash.output).toBe(170 + 41);
    // Thinking is the subset of output it is for every other source, never an addition.
    expect(flash.reasoning).toBe(85 + 23);
    expect(flash.total).toBe(19_149 + 3_276 + 16_292 + 170 + 41);
    expect(flash.costBasis).toBe("public_list");

    // The alias resolves to the published model, so it is priced instead of unpriced.
    const older = rows.find((row) => row.model === "Gemini 3.5 Flash")!;
    expect(older.effort).toBe("high");
    expect(older.costBasis).toBe("public_list");
    expect(summary.unpricedModels).toEqual([]);

    expect(summary.daily.map((day) => day.date)).toEqual(["2026-07-29", "2026-07-30"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a conversation with no request, or an unreadable one, costs only itself", async () => {
  const { paths, root, conversations } = await fixture();
  try {
    // A conversation the CLI opened but never sent a request through.
    const empty = new Database(join(conversations, "c.db"), { create: true });
    empty.run("CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY)");
    empty.close();
    // A blob truncated mid-message: the record ends, the scan does not.
    conversation(join(conversations, "d.db"), [
      record("gemini-3.6-flash", "Gemini 3.6 Flash (High)", { input: 500, output: 10 }, 1_785_431_300)
        .slice(0, 12),
    ]);

    const summary = await collectUsage(paths);
    expect(summary.sources.find((source) => source.id === "antigravity")?.status).toBe("ok");
    expect(summary.rows.filter((row) => row.source === "antigravity")).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable conversation is an error, and a missing directory is not", async () => {
  const { paths, root, conversations } = await fixture();
  try {
    const missing = await collectUsage({ ...paths, antigravity: join(root, "absent") });
    expect(missing.sources.find((source) => source.id === "antigravity")?.status).toBe("missing");

    await writeFile(join(conversations, "e.db"), "not a database at all");
    const broken = await collectUsage(paths);
    const source = broken.sources.find((entry) => entry.id === "antigravity")!;
    expect(source.status).toBe("error");
    expect(source.message).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
