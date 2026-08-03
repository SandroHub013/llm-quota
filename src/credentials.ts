import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { existsSync } from "node:fs";

/** Safely read + parse a JSON file. Returns undefined on any failure. */
export async function readJson<T = any>(path: string): Promise<T | undefined> {
  try {
    if (!existsSync(path)) return undefined;
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

/** Best-effort JSON write (a no-op on read-only filesystems such as Vercel). */
async function writeJson(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2));
  } catch (e: any) {
    console.warn("writeJson failed (read-only filesystem?):", path, String(e?.message ?? e));
  }
}

const home = homedir();

export const paths = {
  config: join(home, ".llm-quota", "config.json"),
  legacyConfig: join(home, ".webquota", "config.json"),
};

// --- LLM Quota user config (~/.llm-quota/config.json) ---
export interface LlmQuotaConfig {
  keys: Record<string, string>; // providerId -> api key
}
export async function readLlmQuotaConfig(primary: string, legacy: string): Promise<LlmQuotaConfig> {
  return (await readJson<LlmQuotaConfig>(primary)) ?? (await readJson<LlmQuotaConfig>(legacy)) ?? { keys: {} };
}
export async function readConfig(): Promise<LlmQuotaConfig> {
  return readLlmQuotaConfig(paths.config, paths.legacyConfig);
}
export async function writeConfig(cfg: LlmQuotaConfig): Promise<void> {
  await writeJson(paths.config, cfg);
}
