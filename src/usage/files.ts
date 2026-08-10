import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export async function* lines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) yield line;
}

export async function walk(root: string, name: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(name)) found.push(path);
    }
  }
  return found;
}
