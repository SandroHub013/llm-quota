import { stat } from "node:fs/promises";

export interface FileCacheEntry<T> {
  size: number;
  mtimeMs: number;
  value: T;
}

/**
 * Read one local history file, reusing the previous parse while size and mtime hold.
 *
 * Returns undefined instead of throwing. The supported CLIs rotate and delete their
 * own session files while this dashboard polls, so a path listed by `walk` can be
 * gone by the time it is read. Letting that escape would abandon the whole source
 * and discard every row already collected, dropping the spend total to zero.
 */
export async function cachedFile<T>(
  cache: Map<string, FileCacheEntry<T>>,
  path: string,
  read: () => Promise<T>,
): Promise<T | undefined> {
  try {
    const info = await stat(path);
    const cached = cache.get(path);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.value;
    const value = await read();
    cache.set(path, { size: info.size, mtimeMs: info.mtimeMs, value });
    return value;
  } catch {
    cache.delete(path);
    return undefined;
  }
}

/**
 * Forget files that this scan no longer sees. The caches are keyed by path and the
 * server is meant to run for days, so without this every session file ever read
 * stays resident long after the CLI has deleted it.
 */
export function pruneCache<T>(cache: Map<string, FileCacheEntry<T>>, live: Iterable<string>): void {
  const keep = new Set(live);
  for (const path of cache.keys()) {
    if (!keep.has(path)) cache.delete(path);
  }
}
