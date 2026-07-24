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
