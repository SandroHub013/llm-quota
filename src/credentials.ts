import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { existsSync } from "node:fs";
import { writeJsonAtomic } from "./atomic-write.js";

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

// Serialize read-modify-write operations from concurrent browser tabs and widget
// requests. The queue keeps the next operation running even when one write fails.
let configWriteQueue: Promise<void> = Promise.resolve();

function enqueueConfigWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = configWriteQueue.then(operation);
  configWriteQueue = result.then(() => undefined, () => undefined);
  return result;
}

const home = homedir();

export const paths = {
  config: join(home, ".llm-quota", "config.json"),
  legacyConfig: join(home, ".webquota", "config.json"),
};

// --- LLM Quota user config (~/.llm-quota/config.json) ---
export interface LlmQuotaConfig {
  keys: Record<string, string>; // providerId -> api key
  /** Shared usage-table filters; dashboard, its button and the widget all read them. */
  usageView?: { source?: string; agent?: string };
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
  const safeKeys = usable
    ? Object.fromEntries(Object.entries(keys).filter(([, value]) => typeof value === "string"))
    : {};
  return { ...found, keys: safeKeys };
}
export async function readConfig(): Promise<LlmQuotaConfig> {
  return readLlmQuotaConfig(paths.config, paths.legacyConfig);
}

/** Write a config at an explicit path; exported for focused filesystem tests. */
export function writeConfigAt(path: string, cfg: LlmQuotaConfig): Promise<void> {
  return enqueueConfigWrite(() => writeJsonAtomic(path, cfg));
}

export function writeConfig(cfg: LlmQuotaConfig): Promise<void> {
  return writeConfigAt(paths.config, cfg);
}

/** Serialize the complete read-modify-write transaction used by API endpoints. */
export function updateConfig(
  update: (cfg: LlmQuotaConfig) => LlmQuotaConfig | Promise<LlmQuotaConfig>,
): Promise<LlmQuotaConfig> {
  return enqueueConfigWrite(async () => {
    const next = await update(await readConfig());
    await writeJsonAtomic(paths.config, next);
    return next;
  });
}
