import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

import { existsSync } from "node:fs";

import { reasonOf, warnOnce } from "./log.js";

/** A file that is present on disk but could not be read or parsed. */
export class JsonFileUnreadableError extends Error {
  constructor(public readonly path: string, cause: unknown) {
    super(`unreadable_json_file: ${path}: ${reasonOf(cause)}`, { cause });
    this.name = "JsonFileUnreadableError";
  }
}

/**
 * Read + parse a JSON file.
 *
 * Absent is not a failure — every file behind this helper is optional — so a
 * missing path returns undefined. A file that *exists* and still cannot be read
 * throws `JsonFileUnreadableError`, because "absent" and "corrupt" call for
 * opposite handling: the first is the normal first-run state, the second means
 * the user has data here that this process cannot see.
 */
export async function readJsonStrict<T = any>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    // A file that vanished between the check and the read is genuinely absent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new JsonFileUnreadableError(path, error);
  }
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new JsonFileUnreadableError(path, error);
  }
}

/**
 * Lenient wrapper for optional caches and metadata, where an unreadable file is
 * equivalent to a missing one. The reason is logged rather than dropped, so a
 * card that stays empty can be explained without a debugger.
 *
 * Do not use this on a path that is about to be rewritten: see `updateConfig`.
 */
export async function readJson<T = any>(path: string): Promise<T | undefined> {
  try {
    return await readJsonStrict<T>(path);
  } catch (error) {
    warnOnce(`readJson:${path}`, "continuing without an optional file", error);
    return undefined;
  }
}

/**
 * Write a config atomically and repair its permissions on every update. A temp file
 * in the same directory makes a crash leave either the old JSON or the new JSON,
 * never a truncated credential file.
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Not every filesystem carries POSIX modes (Windows, FAT, some network mounts), and
  // a config that cannot be locked down is still better than no config. The write goes
  // ahead — but the file holds API keys, so the weaker permissions are reported once
  // instead of being assumed.
  await restrict(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await restrict(temporary, 0o600);
    await rename(temporary, path);
    // chmod is required because `mode` is ignored when a destination already exists.
    await restrict(path, 0o600);
  } finally {
    // Cleanup only: on the success path the rename already consumed the temp file,
    // and on the failure path the caller is being handed the original error.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function restrict(path: string, mode: number): Promise<void> {
  await chmod(path, mode).catch((error) => {
    warnOnce(`chmod:${path}`, `could not restrict ${path} to ${mode.toString(8)}`, error);
  });
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
  return shapeConfig((await readJson<LlmQuotaConfig>(primary)) ?? (await readJson<LlmQuotaConfig>(legacy)));
}

function shapeConfig(found: LlmQuotaConfig | undefined): LlmQuotaConfig {
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

/**
 * Serialize the complete read-modify-write transaction used by API endpoints.
 *
 * The read half is strict, unlike `readConfig`. A config.json that exists but does
 * not parse — a hand-edit with a trailing comma is the documented case — reads as
 * `{ keys: {} }` under the lenient path, and writing that back replaces every stored
 * API key with nothing. There is no undo for that, so an unreadable file aborts the
 * update and the endpoint reports it instead.
 */
export function updateConfig(
  update: (cfg: LlmQuotaConfig) => LlmQuotaConfig | Promise<LlmQuotaConfig>,
  path: string = paths.config,
): Promise<LlmQuotaConfig> {
  return enqueueConfigWrite(async () => {
    // Same primary-then-legacy order as readConfig, so an update still migrates keys
    // from ~/.webquota; strict on both, because either one can be the file whose keys
    // this write is about to replace.
    const current = (await readJsonStrict<LlmQuotaConfig>(path))
      ?? (path === paths.config ? await readJsonStrict<LlmQuotaConfig>(paths.legacyConfig) : undefined);
    const next = await update(shapeConfig(current));
    await writeJsonAtomic(path, next);
    return next;
  });
}
