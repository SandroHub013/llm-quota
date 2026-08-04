import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLlmQuotaConfig } from "./credentials.js";

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

  expect(await readLlmQuotaConfig(primary, join(dir, "absent.json"))).toEqual({
    keys: { codex: "k" },
    theme: "dark",
  } as any);
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
