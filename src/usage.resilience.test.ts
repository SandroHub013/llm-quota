import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage, type UsagePaths } from "./usage.js";

const assistant = (id: string) => JSON.stringify({
  type: "assistant",
  timestamp: "2026-08-01T10:00:00Z",
  message: {
    id,
    model: "claude-opus-5",
    usage: { input_tokens: 100, output_tokens: 50 },
  },
});

async function fixture(files: number): Promise<{ paths: UsagePaths; root: string; names: string[] }> {
  const root = await mkdtemp(join(tmpdir(), "llm-quota-usage-"));
  const claude = join(root, "claude");
  await mkdir(claude, { recursive: true });
  const names: string[] = [];
  for (let index = 0; index < files; index += 1) {
    const path = join(claude, `session-${index}.jsonl`);
    await writeFile(path, `${assistant(`message-${index}`)}\n`, "utf8");
    names.push(path);
  }
  return {
    root,
    names,
    paths: {
      codex: join(root, "codex"),
      claude,
      kimi: join(root, "kimi"),
      opencodeDb: join(root, "missing.db"),
      pi: join(root, "pi"),
      prime: join(root, "prime"),
      nikcliDb: join(root, "missing-nikcli.db"),
      antigravity: join(root, "absent-antigravity"),
    },
  };
}

// The supported CLIs rotate and delete their own session files while this dashboard
// polls /api/usage every five seconds. Before this, one file disappearing between the
// directory walk and its read aborted the whole source: the ledger reported zero tokens
// and the headline spend total fell to nothing while the history was still on disk.
test("a session file deleted mid-scan costs only that file, not the whole source", async () => {
  const { paths, names, root } = await fixture(40);
  try {
    const complete = await collectUsage(paths);
    expect(complete.tokens.total).toBe(40 * 150);

    await rm(names[7]!, { force: true });
    const afterDelete = await collectUsage(paths);

    expect(afterDelete.sources.find((source) => source.id === "claude")?.status).toBe("ok");
    expect(afterDelete.tokens.total).toBe(39 * 150);
    expect(afterDelete.estimatedCostEur).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Every source is read the same way, so an unreadable file must not take the others
// down with it either.
test("one unreadable source leaves the remaining sources reporting", async () => {
  const { paths, root } = await fixture(3);
  try {
    const summary = await collectUsage({ ...paths, codex: join(root, "does-not-exist") });
    expect(summary.sources.find((source) => source.id === "claude")?.status).toBe("ok");
    expect(summary.tokens.total).toBe(3 * 150);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
