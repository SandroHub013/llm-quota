/**
 * Error paths for the official status-line bridge and for the CLI's `stats`.
 *
 * Both used to answer a failure with a confident-looking value: "the bridge is not
 * installed" for a settings file that could not be read, and "0 downloads" for a
 * network that was never reached.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { officialBridgeInstalled, officialBridgePaths } from "./official-bridge.js";
import { fetchClaudeQuota } from "./providers/claude.js";
import { fetchGeminiQuota } from "./providers/gemini.js";
import { fetchProjectStats } from "./cli.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

/** A home directory where the Claude bridge is installed and its metadata is on disk. */
async function bridgedHome(settings: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-"));
  dirs.push(home);
  const paths = officialBridgePaths("claude", home, "linux");
  await mkdir(paths.root, { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(paths.metadata, JSON.stringify({
    version: 1,
    provider: "claude",
    configPath: paths.config,
    installedAt: "2026-01-01T00:00:00Z",
  }));
  await writeFile(paths.config, settings);
  return home;
}

const installedSettings = (home: string) => JSON.stringify({
  statusLine: {
    type: "command",
    command: `bun ${officialBridgePaths("claude", home, "linux").script}`,
  },
});

test("an installed bridge is still reported as installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-probe-"));
  dirs.push(home);
  await rm(home, { recursive: true, force: true });
  const real = await bridgedHome("{}");
  await writeFile(officialBridgePaths("claude", real, "linux").config, installedSettings(real));

  expect(await officialBridgeInstalled("claude", real)).toBe(true);
});

// The bug: a hand-edited settings.json made the card decide the bridge was off, which
// hides the teardown button — the only way to remove the wrapper from the dashboard.
test("a settings file that cannot be parsed is not silently read as 'not installed'", async () => {
  const home = await bridgedHome('{ "statusLine": { "type": "command", }');

  const error = await officialBridgeInstalled("claude", home).then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("invalid_settings_json");
  expect((error as Error).message).toContain(join(home, ".claude", "settings.json"));
  // The parser's own message survives, so the user can find the offending line.
  expect((error as Error).cause).toBeDefined();
});

test("a settings file holding a JSON array rather than an object is rejected with the reason", async () => {
  const home = await bridgedHome("[1, 2, 3]");

  const error = await officialBridgeInstalled("claude", home).then(() => undefined, (e: unknown) => e);
  expect((error as Error).message).toContain("invalid_settings_json");
  expect(String((error as Error).cause)).toContain("array");
});

test("an absent settings file still means 'not installed', not an error", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-"));
  dirs.push(home);
  expect(await officialBridgeInstalled("claude", home)).toBe(false);
});

// The Provider contract says fetch() must never throw. It must not go quiet either:
// the card has to name the file the user needs to repair.
test("the Claude card surfaces an unreadable settings file instead of throwing", async () => {
  const home = await bridgedHome("{ broken");

  const result = await fetchClaudeQuota(home);
  expect(result.status).toBe("error");
  expect(result.message).toContain("settings file");
  expect(result.message).toContain("Repair");
  // The contract the adapter is bound by: a failure is a QuotaResult, never a throw.
  expect(result.id).toBe("claude");
});

test("the Antigravity card does the same for its own settings file", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-"));
  dirs.push(home);
  const paths = officialBridgePaths("gemini", home, "linux");
  await mkdir(paths.root, { recursive: true });
  await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  await writeFile(paths.metadata, JSON.stringify({
    version: 1, provider: "gemini", configPath: paths.config, installedAt: "2026-01-01T00:00:00Z",
  }));
  await writeFile(paths.config, "{ broken");

  const result = await fetchGeminiQuota(home);
  expect(result.status).toBe("error");
  expect(result.message).toContain("Repair");
});

// The normal, non-error path of the same function, which had no coverage at all.
test("a home with no bridge offers the opt-in instead of an error", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-"));
  dirs.push(home);

  const result = await fetchClaudeQuota(home);
  expect(result.status).toBe("partial");
  expect(result.setupUrl).toBe("/api/official-bridge/claude");
  expect(result.teardownUrl).toBeUndefined();
});

test("a fresh bridge snapshot produces live metrics", async () => {
  const home = await bridgedHome("{}");
  const paths = officialBridgePaths("claude", home, "linux");
  await writeFile(paths.config, installedSettings(home));
  await writeFile(paths.cache, JSON.stringify({
    version: 1,
    provider: "claude",
    capturedAt: new Date().toISOString(),
    data: { rateLimits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 7 } } },
  }));

  const result = await fetchClaudeQuota(home);
  expect(result.status).toBe("ok");
  expect(result.metrics.map((metric) => metric.used)).toEqual([42, 7]);
  expect(result.teardownUrl).toBe("/api/official-bridge/claude");
});

// An unreadable *cache* is not the same failure: the bridge is fine, the snapshot is
// not, and the card should fall back to its opt-in state rather than break.
test("an unreadable bridge snapshot degrades to the setup state", async () => {
  const home = await bridgedHome("{}");
  const paths = officialBridgePaths("claude", home, "linux");
  await writeFile(paths.config, installedSettings(home));
  await writeFile(paths.cache, "{ truncated");

  const result = await fetchClaudeQuota(home);
  expect(result.status).toBe("partial");
  expect(result.metrics).toEqual([]);
  expect(result.teardownUrl).toBe("/api/official-bridge/claude");
});

// `stats` printed "0" for a DNS failure. Zero is a real download count.
test("stats reports an unreachable registry as unavailable, never as zero", async () => {
  const offline = () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.npmjs.org"));

  const output = await fetchProjectStats(offline as never);
  expect(output).toContain("unavailable");
  expect(output).toContain("ENOTFOUND");
  expect(output).not.toMatch(/:\s*0$/m);
});

test("stats reports an HTTP error as unavailable, with the status", async () => {
  const rateLimited = () => Promise.resolve(new Response("nope", { status: 429 }));

  const output = await fetchProjectStats(rateLimited as never);
  expect(output).toContain("unavailable");
  expect(output).toContain("http_429");
});

test("stats still prints a genuine zero as a number", async () => {
  const empty = (input: string | URL | Request) =>
    Promise.resolve(Response.json(String(input).includes("npmjs") ? { downloads: 0 } : []));

  const output = await fetchProjectStats(empty as never);
  expect(output).toBe("NPM Downloads (last 30d): 0\nGitHub Release Downloads: 0");
});

test("stats sums release assets when both registries answer", async () => {
  const populated = (input: string | URL | Request) =>
    Promise.resolve(Response.json(
      String(input).includes("npmjs")
        ? { downloads: 4321 }
        : [{ assets: [{ download_count: 10 }, { download_count: 5 }] }, { assets: [{ download_count: 2 }] }],
    ));

  expect(await fetchProjectStats(populated as never)).toBe(
    "NPM Downloads (last 30d): 4321\nGitHub Release Downloads: 17",
  );
});

// A body that parses but is not the documented shape is a failure, not a zero.
test("stats reports a malformed payload as unavailable", async () => {
  const nonsense = () => Promise.resolve(Response.json({ unexpected: true }));

  const output = await fetchProjectStats(nonsense as never);
  expect(output).toContain("unavailable");
});
