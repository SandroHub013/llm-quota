import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /**
   * Bridge targets live in the official clients' own config directories, where a
   * locked destination (Windows file locking, sync tools) can make the rename
   * fail. There a direct write beats losing the settings update, at the price of
   * a brief non-atomic window. Credential files keep the strict all-or-nothing
   * behavior and leave this off.
   */
  fallbackToDirectWrite?: boolean;
}

/**
 * Write a JSON file atomically and repair its permissions on every update. A temp
 * file in the same directory makes a crash leave either the old JSON or the new
 * JSON, never a truncated credential file.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const temporary = `${path}.${randomUUID()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(temporary, json, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => {});
    await rename(temporary, path).catch(async (error) => {
      if (!options.fallbackToDirectWrite) throw error;
      await writeFile(path, json, { mode: 0o600 });
    });
    // chmod is required because `mode` is ignored when a destination already exists.
    await chmod(path, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
