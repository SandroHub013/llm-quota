/**
 * Error paths for the credential store. Every test here fails if the guard it
 * covers is removed; the point of the file is that a config this process cannot
 * read is never treated as a config that is empty.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonFileUnreadableError,
  readJson,
  readJsonStrict,
  readLlmQuotaConfig,
  updateConfig,
} from "./credentials.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-quota-errors-"));
  dirs.push(dir);
  return dir;
}

const CORRUPT = `{
  "keys": { "claude": "sk-claude", "codex": "sk-codex", "gemini": "sk-gemini", },
}
`;

test("an absent file reads as undefined, not as an error", async () => {
  const dir = await scratch();
  expect(await readJsonStrict(join(dir, "nope.json"))).toBeUndefined();
});

test("a file that exists but does not parse throws, naming the path and the cause", async () => {
  const dir = await scratch();
  const path = join(dir, "config.json");
  await writeFile(path, CORRUPT);

  const error = await readJsonStrict(path).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(JsonFileUnreadableError);
  expect((error as JsonFileUnreadableError).path).toBe(path);
  expect((error as JsonFileUnreadableError).message).toContain(path);
  // The parser's own complaint is preserved rather than replaced by a generic string.
  expect((error as JsonFileUnreadableError).cause).toBeInstanceOf(Error);
});

test("the lenient reader still degrades to undefined for optional caches", async () => {
  const dir = await scratch();
  const path = join(dir, "cache.json");
  await writeFile(path, "{ not json");
  expect(await readJson(path)).toBeUndefined();
});

// The bug this file was written for: the lenient read turned a corrupt config into
// `{ keys: {} }`, and the next key save wrote that back over three live API keys.
test("updateConfig refuses to overwrite a config it could not read", async () => {
  const dir = await scratch();
  const path = join(dir, "config.json");
  await writeFile(path, CORRUPT);

  const error = await updateConfig(
    (config) => ({ ...config, keys: { ...config.keys, moonshot: "sk-new" } }),
    path,
  ).then(() => undefined, (e: unknown) => e);

  expect(error).toBeInstanceOf(JsonFileUnreadableError);
  // The decisive assertion: the keys are still on disk, byte for byte.
  expect(await readFile(path, "utf8")).toBe(CORRUPT);
});

test("updateConfig still performs a normal read-modify-write", async () => {
  const dir = await scratch();
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ keys: { claude: "sk-claude" }, theme: "dark" }));

  const next = await updateConfig(
    (config) => ({ ...config, keys: { ...config.keys, codex: "sk-codex" } }),
    path,
  );

  expect(next.keys).toEqual({ claude: "sk-claude", codex: "sk-codex" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    keys: { claude: "sk-claude", codex: "sk-codex" },
    theme: "dark",
  });
});

test("updateConfig on a path with no file yet starts from an empty key set", async () => {
  const dir = await scratch();
  const path = join(dir, "fresh", "config.json");

  const next = await updateConfig((config) => ({ ...config, keys: { ...config.keys, zai: "k" } }), path);

  expect(next.keys).toEqual({ zai: "k" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ keys: { zai: "k" } });
});

// A failed update must not wedge the queue every later write goes through.
test("a refused update leaves the write queue usable", async () => {
  const dir = await scratch();
  const corrupt = join(dir, "corrupt.json");
  const healthy = join(dir, "healthy.json");
  await writeFile(corrupt, CORRUPT);

  expect(updateConfig((config) => config, corrupt)).rejects.toBeInstanceOf(JsonFileUnreadableError);
  const next = await updateConfig((config) => ({ ...config, keys: { gemini: "g" } }), healthy);

  expect(next.keys).toEqual({ gemini: "g" });
});

test("a readable config keeps reading leniently through readLlmQuotaConfig", async () => {
  const dir = await scratch();
  const primary = join(dir, "primary.json");
  const legacy = join(dir, "legacy.json");
  await writeFile(primary, "{ broken");
  await writeFile(legacy, JSON.stringify({ keys: { zai: "legacy" } }));

  // Reading is not destructive, so a corrupt primary may still fall back to legacy —
  // the strictness belongs to the write path, which is what would lose data.
  expect(await readLlmQuotaConfig(primary, legacy)).toEqual({ keys: { zai: "legacy" } });
});

// The API contract for the refusal above: a corrupt config is a conflict the user
// has to resolve, and the response has to say which file and that nothing was lost.
test("an unreadable config maps to a 409 body naming the file", async () => {
  const { configConflictBody } = await import("./server.js");
  const body = configConflictBody(new JsonFileUnreadableError("/home/u/.llm-quota/config.json", new Error("bad")));

  expect(body).toBeDefined();
  expect(body!.error).toBe("config unreadable");
  expect(body!.detail).toContain("/home/u/.llm-quota/config.json");
  expect(body!.detail).toContain("left untouched");
});

test("an unrelated failure is not relabelled as a config conflict", async () => {
  const { configConflictBody } = await import("./server.js");
  expect(configConflictBody(new Error("disk full"))).toBeUndefined();
});
