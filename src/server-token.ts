import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "./atomic-write.js";
import { paths, readJson } from "./credentials.js";

/**
 * Non-GET /api calls rewrite credentials and official-client settings, and the
 * Origin guard cannot see non-browser processes — they simply omit the header.
 * The server therefore shares a random token through a 0600 file next to the
 * credentials: only a process that can already read the user's own files can
 * present it. The token persists across restarts, so the CLI and the widget do
 * not need to re-pair when the server reboots.
 */
export const SERVER_TOKEN_PATH = join(dirname(paths.config), "server-token");

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Reuse the persisted token when it is intact; generate and store one otherwise. */
export async function loadServerToken(): Promise<string> {
  const stored = await readJson<{ token?: unknown }>(SERVER_TOKEN_PATH);
  if (typeof stored?.token === "string" && TOKEN_PATTERN.test(stored.token)) {
    return stored.token;
  }
  const token = randomBytes(32).toString("hex");
  await writeJsonAtomic(SERVER_TOKEN_PATH, { token });
  return token;
}
