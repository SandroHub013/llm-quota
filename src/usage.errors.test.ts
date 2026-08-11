/**
 * Error paths for the local usage ledger.
 *
 * The rule the whole file tests: a source that could not be read must never look
 * like a source that had nothing to read. "missing, 0 files" is a claim about the
 * user's machine, and making it when the real answer is "I could not look" hides
 * spend the dashboard exists to show.
 */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage, type UsagePaths, type UsageSourceStatus } from "./usage.js";

const assistant = (id: string, output = 50) => JSON.stringify({
  type: "assistant",
  timestamp: "2026-08-01T10:00:00Z",
  message: { id, model: "claude-opus-5", usage: { input_tokens: 100, output_tokens: output } },
});

const roots: string[] = [];

async function scratch(): Promise<{ root: string; claude: string; paths: UsagePaths }> {
  const root = await mkdtemp(join(tmpdir(), "llm-quota-usage-errors-"));
  roots.push(root);
  const claude = join(root, "claude");
  return {
    root,
    claude,
    paths: {
      codex: join(root, "absent-codex"),
      claude,
      kimi: join(root, "absent-kimi"),
      opencodeDb: join(root, "absent.db"),
      pi: join(root, "absent-pi"),
      prime: join(root, "absent-prime"),
      nikcliDb: join(root, "absent-nikcli.db"),
    },
  };
}

const sourceOf = (sources: UsageSourceStatus[], id: string): UsageSourceStatus =>
  sources.find((source) => source.id === id)!;

async function cleanup(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

// A path that is not a directory produced ENOTDIR inside walk, was swallowed into an
// empty file list, and surfaced as "missing / 0 files" — the same answer a machine
// that has never run Claude Code gets.
test("a history path that is not a directory is an error, not an empty history", async () => {
  const { claude, paths } = await scratch();
  try {
    await writeFile(claude, "this is a file, not a session directory");

    const source = sourceOf((await collectUsage(paths)).sources, "claude");
    expect(source.status).toBe("error");
    expect(source.message).toContain(claude);
    expect(source.message).toContain("ENOTDIR");
  } finally {
    await cleanup();
  }
});

// The message field is what the dashboard and the widget render. An "error" chip with
// nothing in it tells the user only that something is wrong somewhere.
test("a failing source always carries a non-empty reason", async () => {
  const { claude, paths } = await scratch();
  try {
    await writeFile(claude, "not a directory");

    const failing = (await collectUsage(paths)).sources.filter((source) => source.status === "error");
    // Guard against passing vacuously: if nothing failed, the fixture stopped working.
    expect(failing.length).toBeGreaterThan(0);
    for (const source of failing) {
      expect(source.message).toBeTruthy();
      expect(source.message!.length).toBeGreaterThan(10);
    }
  } finally {
    await cleanup();
  }
});

// One broken source must still not blank the ledger: the isolation that justified the
// original catch is kept, only the silence is removed.
test("a failing source leaves the other sources reporting normally", async () => {
  const { root, claude, paths } = await scratch();
  try {
    await mkdir(claude, { recursive: true });
    await writeFile(join(claude, "a.jsonl"), `${assistant("m1")}\n`);
    const codex = join(root, "broken-codex");
    await writeFile(codex, "not a directory");

    const summary = await collectUsage({ ...paths, codex });
    expect(sourceOf(summary.sources, "codex").status).toBe("error");
    expect(sourceOf(summary.sources, "claude").status).toBe("ok");
    expect(summary.tokens.total).toBe(150);
  } finally {
    await cleanup();
  }
});

// Found while auditing walk: `withFileTypes` reports a symlink as neither file nor
// directory, so an entire session tree reached through one was skipped in silence and
// its tokens never reached the total.
test("a session tree behind a symlinked directory is counted", async () => {
  const { root, claude, paths } = await scratch();
  try {
    const elsewhere = join(root, "on-another-disk");
    await mkdir(claude, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(claude, "here.jsonl"), `${assistant("local", 50)}\n`);
    await writeFile(join(elsewhere, "there.jsonl"), `${assistant("linked", 950)}\n`);
    await symlink(elsewhere, join(claude, "work"), "dir");

    const summary = await collectUsage(paths);
    expect(sourceOf(summary.sources, "claude").status).toBe("ok");
    expect(sourceOf(summary.sources, "claude").files).toBe(2);
    // 100+50 from the local file, 100+950 from the one behind the symlink.
    expect(summary.tokens.total).toBe(1200);
  } finally {
    await cleanup();
  }
});

test("a symlinked session file is counted too", async () => {
  const { root, claude, paths } = await scratch();
  try {
    const elsewhere = join(root, "store");
    await mkdir(claude, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, "real.jsonl"), `${assistant("linked", 900)}\n`);
    await symlink(join(elsewhere, "real.jsonl"), join(claude, "linked.jsonl"), "file");

    expect((await collectUsage(paths)).tokens.total).toBe(1000);
  } finally {
    await cleanup();
  }
});

// Following symlinks must not let a self-referential tree spin forever.
test("a symlink cycle terminates instead of hanging the scan", async () => {
  const { claude, paths } = await scratch();
  try {
    const nested = join(claude, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "a.jsonl"), `${assistant("m1")}\n`);
    await symlink(claude, join(nested, "loop"), "dir");

    const summary = await collectUsage(paths);
    expect(sourceOf(summary.sources, "claude").status).toBe("ok");
    expect(summary.tokens.total).toBe(150);
  } finally {
    await cleanup();
  }
});

// The race the original catch was written for has to keep working: a truncated final
// line is normal in a log that is being appended to right now.
test("a half-written final record costs that record, not the file", async () => {
  const { claude, paths } = await scratch();
  try {
    await mkdir(claude, { recursive: true });
    await writeFile(
      join(claude, "live.jsonl"),
      `${assistant("m1")}\n${assistant("m2")}\n{"type":"assistant","message":{"id":"m3","usa`,
    );

    const summary = await collectUsage(paths);
    expect(sourceOf(summary.sources, "claude").status).toBe("ok");
    expect(summary.tokens.total).toBe(2 * 150);
  } finally {
    await cleanup();
  }
});

// An empty directory is a real, ordinary answer and must stay distinguishable from
// the failures above.
test("an existing but empty history directory still reads as missing, not error", async () => {
  const { claude, paths } = await scratch();
  try {
    await mkdir(claude, { recursive: true });

    const source = sourceOf((await collectUsage(paths)).sources, "claude");
    expect(source.status).toBe("missing");
    expect(source.files).toBe(0);
    expect(source.message).toBeUndefined();
  } finally {
    await cleanup();
  }
});
