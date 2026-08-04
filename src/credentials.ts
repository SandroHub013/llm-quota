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

/**
 * Best-effort JSON write (a no-op on read-only filesystems such as Vercel).
 *
 * Written 0600: this file holds provider API keys, and the default 0644 leaves them
 * readable by every other account on a shared machine.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
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
/**
 * `keys` is always present, even when the file on disk is a bare `{}` or was edited
 * by hand. Every provider read goes through `config.keys[id]`, so a missing field
 * there is not a local error: it fails each card at once with an internal message.
 */
export async function readLlmQuotaConfig(primary: string, legacy: string): Promise<LlmQuotaConfig> {
  const found = (await readJson<LlmQuotaConfig>(primary)) ?? (await readJson<LlmQuotaConfig>(legacy));
  const keys = found?.keys;
  const usable = keys != null && typeof keys === "object" && !Array.isArray(keys);
  return { ...found, keys: usable ? { ...keys } : {} };
}
export async function readConfig(): Promise<LlmQuotaConfig> {
  return readLlmQuotaConfig(paths.config, paths.legacyConfig);
}
export async function writeConfig(cfg: LlmQuotaConfig): Promise<void> {
  await writeJson(paths.config, cfg);
}
