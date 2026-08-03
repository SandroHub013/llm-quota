import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPowerShellBridge,
  groupCaches,
  installOfficialBridge,
  officialBridgeInstalled,
  officialBridgePaths,
  readOfficialBridgeSnapshot,
  removeOfficialBridge,
} from "./official-bridge.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

test("Claude bridge preserves and chains an existing status line", async () => {
  if (process.platform !== "win32") return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  await Bun.write(paths.config, JSON.stringify({ statusLine: { type: "command", command: "node old-line.js", padding: 2 } }));

  await installOfficialBridge("claude", home);

  const settings = JSON.parse(await readFile(paths.config, "utf8"));
  expect(settings.statusLine.command).toContain("claude-statusline-bridge.ps1");
  expect(settings.statusLine.padding).toBe(2);
  expect(await readFile(paths.previous, "utf8")).toContain("node old-line.js");
  expect(await officialBridgeInstalled("claude", home)).toBe(true);
  expect(await Bun.file(`${paths.config}.llm-quota.bak`).exists()).toBe(true);

  await removeOfficialBridge("claude", home);
  const restored = JSON.parse(await readFile(paths.config, "utf8"));
  expect(restored.statusLine).toEqual({ type: "command", command: "node old-line.js", padding: 2 });
  expect(await officialBridgeInstalled("claude", home)).toBe(false);
});

test("snapshot reader accepts only the expected minimal provider cache", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-cache-"));
  homes.push(home);
  const paths = officialBridgePaths("gemini", home);
  await Bun.write(paths.cache, JSON.stringify({
    version: 1,
    provider: "antigravity",
    capturedAt: "2026-08-03T10:00:00Z",
    data: { quota: {} },
  }));
  expect((await readOfficialBridgeSnapshot("gemini", home))?.provider).toBe("antigravity");
  
  const zaiPaths = officialBridgePaths("zai", home);
  await Bun.write(zaiPaths.cache, JSON.stringify({
    version: 1,
    provider: "zai",
    capturedAt: "2026-08-03T10:00:00Z",
    data: { glmQuota: { used_percentage: 15 } },
  }));
  expect((await readOfficialBridgeSnapshot("zai", home))?.provider).toBe("zai");

  await writeFile(paths.cache, JSON.stringify({ version: 1, provider: "claude", capturedAt: "bad", data: {} }));
  expect(await readOfficialBridgeSnapshot("gemini", home)).toBeUndefined();
});

test("generated bridge stores no account identity or transcript fields", () => {
  const script = buildPowerShellBridge("antigravity", { antigravity: "C:\\cache.json" }, "C:\\previous.cmd");
  expect(script).toContain("remaining_fraction");
  expect(script).not.toContain("state.email");
  expect(script).not.toContain("transcript_path");
});

test("Claude and Z.ai share one wrapper instead of chaining into each other", async () => {
  if (process.platform !== "win32") return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-shared-"));
  homes.push(home);
  const claudePaths = officialBridgePaths("claude", home);
  const zaiPaths = officialBridgePaths("zai", home);
  expect(zaiPaths.script).toBe(claudePaths.script);
  await Bun.write(claudePaths.config, JSON.stringify({ statusLine: { type: "command", command: "node old-line.js" } }));

  await installOfficialBridge("claude", home);
  await installOfficialBridge("zai", home);

  // The second install must not record the first wrapper as the previous command.
  expect(await readFile(claudePaths.previous, "utf8")).toContain("node old-line.js");
  expect(await readFile(claudePaths.previous, "utf8")).not.toContain("statusline-bridge.ps1");
  expect(await officialBridgeInstalled("claude", home)).toBe(true);
  expect(await officialBridgeInstalled("zai", home)).toBe(true);

  // Removing one keeps the wrapper alive for the other.
  await removeOfficialBridge("zai", home);
  expect(await officialBridgeInstalled("zai", home)).toBe(false);
  expect(await officialBridgeInstalled("claude", home)).toBe(true);
  expect(await Bun.file(claudePaths.script).exists()).toBe(true);

  await removeOfficialBridge("claude", home);
  const restored = JSON.parse(await readFile(claudePaths.config, "utf8"));
  expect(restored.statusLine).toEqual({ type: "command", command: "node old-line.js" });
  expect(await Bun.file(claudePaths.script).exists()).toBe(false);
});

test("upgrading an older install keeps its restore target", async () => {
  if (process.platform !== "win32") return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-upgrade-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  const legacyCommand = `powershell.exe -NoProfile -File ${paths.script}`;
  await Bun.write(paths.config, JSON.stringify({ statusLine: { type: "command", command: legacyCommand } }));
  await Bun.write(paths.metadata, JSON.stringify({
    version: 1,
    provider: "claude",
    configPath: paths.config,
    hadStatusLine: true,
    originalStatusLine: { type: "command", command: "node old-line.js" },
    installedAt: "2026-08-01T00:00:00.000Z",
  }));

  await installOfficialBridge("claude", home);
  await removeOfficialBridge("claude", home);

  const restored = JSON.parse(await readFile(paths.config, "utf8"));
  expect(restored.statusLine).toEqual({ type: "command", command: "node old-line.js" });
});

test("a pre-existing wrapper command is never captured as the previous status line", async () => {
  if (process.platform !== "win32") return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-legacy-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  const legacy = join(paths.root, "zai-statusline-bridge.ps1");
  await Bun.write(paths.config, JSON.stringify({
    statusLine: { type: "command", command: `powershell.exe -NoProfile -File "${legacy}"` },
  }));

  await installOfficialBridge("claude", home);

  expect(await Bun.file(paths.previous).exists()).toBe(false);
  await removeOfficialBridge("claude", home);
  const restored = JSON.parse(await readFile(paths.config, "utf8"));
  expect(restored.statusLine).toBeUndefined();
});

test("PowerShell bridge writes a minimal cache and keeps the previous status line visible", async () => {
  if (process.platform !== "win32") return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-powershell-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  await Bun.write(paths.previous, "@echo off\r\necho ORIGINAL-LINE\r\n");
  await Bun.write(paths.script, buildPowerShellBridge("claude", groupCaches("claude", home), paths.previous));

  const processHandle = Bun.spawn({
    cmd: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.script],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  processHandle.stdin.write(JSON.stringify({
    email: "must-not-be-cached@example.test",
    transcript_path: "C:\\private\\transcript.jsonl",
    model: { display_name: "Opus" },
    rate_limits: { five_hour: { used_percentage: 23, resets_at: 1785757199 } },
  }));
  processHandle.stdin.end();
  expect(await processHandle.exited).toBe(0);
  expect(await new Response(processHandle.stdout).text()).toContain("ORIGINAL-LINE");

  const cache = await readFile(paths.cache, "utf8");
  expect(cache).toContain('"used_percentage":23');
  expect(cache).not.toContain("must-not-be-cached");
  expect(cache).not.toContain("transcript");
});
