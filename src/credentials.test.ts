import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLlmQuotaConfig, writeConfigAt, type LlmQuotaConfig } from "./credentials.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

test("new LLM Quota config path falls back to legacy WebQuota config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-quota-"));
  dirs.push(dir);
  const primary = join(dir, ".llm-quota", "config.json");
  const legacy = join(dir, ".webquota", "config.json");
  await Bun.write(legacy, JSON.stringify({ keys: { zai: "legacy-key" } }));

  expect(await readLlmQuotaConfig(primary, legacy)).toEqual({ keys: { zai: "legacy-key" } });
});

test("config writes are serialized, valid, and repair restrictive permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-quota-"));
  dirs.push(dir);
  const path = join(dir, "config.json");

  await Promise.all([
    writeConfigAt(path, { keys: { first: "one" } }),
    writeConfigAt(path, { keys: { second: "two" } }),
  ]);

  expect(JSON.parse(await Bun.file(path).text())).toEqual({ keys: { second: "two" } });
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await writeConfigAt(path, { keys: { repaired: "yes" } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
});

// Every provider read goes through `config.keys[id]`, so a file without that field is
// not a local problem: it throws inside fetchOne and fails every card at once with
// "Internal error: undefined is not an object". A hand-edited or bare `{}` must not.
test("a config missing or misshaping `keys` still reads as an empty key set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-quota-"));
  dirs.push(dir);
  const legacy = join(dir, "absent.json");

  for (const stored of ["{}", '{"keys":null}', '{"keys":"oops"}', '{"keys":[]}', "[]"]) {
    const primary = join(dir, `config-${Buffer.from(stored).toString("hex")}.json`);
    await writeFile(primary, stored);
    const config = await readLlmQuotaConfig(primary, legacy);
    expect(config.keys).toEqual({});
    expect(config.keys["claude"]).toBeUndefined();
  }
});

test("unrelated fields in the config survive a read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-quota-"));
  dirs.push(dir);
  const primary = join(dir, "config.json");
  await writeFile(primary, JSON.stringify({ keys: { codex: "k" }, theme: "dark" }));

  // `theme` is not on the type: this asserts the reader keeps fields it does not know
  // about, so an older build does not strip a newer one's settings.
  expect(await readLlmQuotaConfig(primary, join(dir, "absent.json"))).toEqual({
    keys: { codex: "k" },
    theme: "dark",
  } as unknown as LlmQuotaConfig);
});

test("new config wins when both brand paths exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-quota-"));
  dirs.push(dir);
  const primary = join(dir, "new.json");
  const legacy = join(dir, "old.json");
  await Promise.all([
    writeFile(primary, JSON.stringify({ keys: { codex: "new" } })),
    writeFile(legacy, JSON.stringify({ keys: { codex: "old" } })),
  ]);

  expect(await readLlmQuotaConfig(primary, legacy)).toEqual({ keys: { codex: "new" } });
});
