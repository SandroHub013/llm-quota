import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildPosixBridge,
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

const windows = process.platform === "win32";

/**
 * Timeout for the tests that spawn a real interpreter. Bun's 5s default is not a
 * budget for the code under test here: starting powershell.exe or cmd.exe on a cold
 * CI runner costs seconds on its own, which made these tests pass or fail on runner
 * speed rather than on behaviour.
 */
const SPAWN_TIMEOUT_MS = 60_000;

test("Claude bridge preserves and chains an existing status line", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  await Bun.write(paths.config, JSON.stringify({ statusLine: { type: "command", command: "node old-line.js", padding: 2 } }));

  await installOfficialBridge("claude", home);

  const settings = JSON.parse(await readFile(paths.config, "utf8"));
  expect(settings.statusLine.command).toContain(basename(paths.script));
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
  for (const script of [
    buildPowerShellBridge("antigravity", { antigravity: "C:\\cache.json" }, "C:\\previous.cmd"),
    buildPosixBridge("antigravity", { antigravity: "/tmp/cache.json" }, "/tmp/previous.sh"),
  ]) {
    expect(script).toContain("remaining_fraction");
    expect(script).not.toContain("state.email");
    expect(script).not.toContain("transcript_path");
  }
});

test("Claude and Z.ai share one wrapper instead of chaining into each other", async () => {
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
  expect(await readFile(claudePaths.previous, "utf8")).not.toContain("statusline-bridge.");
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

// The Antigravity CLI splits the status-line command itself instead of handing it
// to a shell, so a quoted path reaches PowerShell with the quotes still attached
// and -File rejects it. Only a path that would split on a space may be quoted.
// Claude Code hands the same command to a POSIX shell, which eats every
// backslash of an unquoted path, so the path is spelled with forward slashes.
test("the generated command uses forward slashes and quotes the path only when it contains a space", async () => {
  if (!windows) return;
  const plain = await mkdtemp(join(tmpdir(), "llm-quota-plain-"));
  homes.push(plain);
  const plainPaths = officialBridgePaths("gemini", plain);
  await installOfficialBridge("gemini", plain);
  const plainCommand = JSON.parse(await readFile(plainPaths.config, "utf8")).statusLine.command;
  expect(plainCommand).toContain(`-File ${plainPaths.script.replace(/\\/g, "/")}`);
  expect(plainCommand).not.toContain("\\");
  expect(plainCommand).not.toContain('"');

  const spaced = await mkdtemp(join(tmpdir(), "llm-quota spaced-"));
  homes.push(spaced);
  const spacedPaths = officialBridgePaths("gemini", spaced);
  await installOfficialBridge("gemini", spaced);
  const spacedCommand = JSON.parse(await readFile(spacedPaths.config, "utf8")).statusLine.command;
  expect(spacedCommand).toContain(`-File "${spacedPaths.script.replace(/\\/g, "/")}"`);
});

// A status line runs in whatever environment the host inherited, which routinely
// misses the shell profile that puts ~/.bun/bin on PATH — so the interpreter is
// spelled absolutely, and quoted under the same rule as the script path.
test("the POSIX command runs the resolved Bun executable, not whatever is on PATH", async () => {
  const plain = await mkdtemp(join(tmpdir(), "llm-quota-posix-"));
  homes.push(plain);
  const plainPaths = officialBridgePaths("gemini", plain, "linux");
  await installOfficialBridge("gemini", plain, "linux");
  const plainCommand = JSON.parse(await readFile(plainPaths.config, "utf8")).statusLine.command;
  expect(plainCommand).toBe(`${process.execPath} run ${plainPaths.script}`);
  expect(await officialBridgeInstalled("gemini", plain)).toBe(true);

  const spaced = await mkdtemp(join(tmpdir(), "llm-quota spaced-"));
  homes.push(spaced);
  const spacedPaths = officialBridgePaths("gemini", spaced, "linux");
  await installOfficialBridge("gemini", spaced, "linux");
  const spacedCommand = JSON.parse(await readFile(spacedPaths.config, "utf8")).statusLine.command;
  expect(spacedCommand).toContain(`run "${spacedPaths.script}"`);
});

// The whole install/uninstall round trip on the non-Windows spelling: a `.mjs`
// wrapper, an `sh` previous-command file, and a settings file left exactly as it
// was found.
test("the POSIX install preserves and restores an existing status line", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-posix-roundtrip-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home, "linux");
  await Bun.write(paths.config, JSON.stringify({
    statusLine: { type: "command", command: "bash ~/.claude/statusline.sh", padding: 1 },
  }));

  await installOfficialBridge("claude", home, "linux");

  expect(paths.script).toEndWith("claude-statusline-bridge.mjs");
  expect(await readFile(paths.previous, "utf8")).toBe("#!/bin/sh\nbash ~/.claude/statusline.sh\n");
  // The generator embeds paths as JS literals, so a Windows run of this POSIX
  // simulation sees the escaped spelling rather than the raw one.
  expect(await readFile(paths.script, "utf8")).toContain(JSON.stringify(paths.cache));
  expect(await officialBridgeInstalled("claude", home)).toBe(true);

  await removeOfficialBridge("claude", home, "linux");
  const restored = JSON.parse(await readFile(paths.config, "utf8"));
  expect(restored.statusLine).toEqual({ type: "command", command: "bash ~/.claude/statusline.sh", padding: 1 });
  expect(existsSync(paths.script)).toBe(false);
  expect(existsSync(paths.previous)).toBe(false);
});

// A forward-slash command must still be recognised as ours, or a reinstall would
// capture the bridge as the "previous" status line and chain it into itself.
test("a forward-slash bridge command is still recognised on reinstall", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-slashes-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  await installOfficialBridge("claude", home);
  await installOfficialBridge("claude", home);
  const previous = existsSync(paths.previous) ? await readFile(paths.previous, "utf8") : "";
  expect(previous).not.toContain("statusline-bridge.");
  expect(await officialBridgeInstalled("claude", home)).toBe(true);
});

test("upgrading an older install keeps its restore target", async () => {
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
  if (!windows) return;
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
  await processHandle.stdin.write(JSON.stringify({
    email: "must-not-be-cached@example.test",
    transcript_path: "C:\\private\\transcript.jsonl",
    model: { display_name: "Opus" },
    rate_limits: { five_hour: { used_percentage: 23, resets_at: 1785757199 } },
  }));
  // Deliberately not awaited. end() resolves once the pipe has been drained, which on
  // Windows means waiting out PowerShell's startup before this test moves on instead of
  // overlapping with it — enough to push these two past the default timeout. `exited`
  // below is a strictly stronger guarantee: a process that exited has read its stdin.
  void processHandle.stdin.end();
  expect(await processHandle.exited).toBe(0);
  expect(await new Response(processHandle.stdout).text()).toContain("ORIGINAL-LINE");

  const cache = await readFile(paths.cache, "utf8");
  expect(cache).toContain('"used_percentage":23');
  expect(cache).not.toContain("must-not-be-cached");
  expect(cache).not.toContain("transcript");
}, SPAWN_TIMEOUT_MS);

// The same privacy contract as the PowerShell bridge, on the interpreter every
// other platform uses. Bun runs the generated module on Windows too, so only the
// /bin/sh chaining below is genuinely POSIX-only.
test("POSIX bridge writes a minimal cache and prints a UTF-8 summary line", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-posix-run-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home, "linux");
  await Bun.write(paths.script, buildPosixBridge("claude", groupCaches("claude", home), paths.previous));

  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", paths.script],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // The leading BOM is the one a host is free to prefix; JSON.parse rejects it raw.
  await processHandle.stdin.write("﻿" + JSON.stringify({
    email: "must-not-be-cached@example.test",
    transcript_path: "/private/transcript.jsonl",
    model: { display_name: "Opus" },
    context_window: { used_percentage: 12 },
    rate_limits: { five_hour: { used_percentage: 23, resets_at: 1785757199 } },
  }));
  // Deliberately not awaited. end() resolves once the pipe has been drained, which on
  // Windows means waiting out PowerShell's startup before this test moves on instead of
  // overlapping with it — enough to push these two past the default timeout. `exited`
  // below is a strictly stronger guarantee: a process that exited has read its stdin.
  void processHandle.stdin.end();
  expect(await processHandle.exited).toBe(0);

  const line = await new Response(processHandle.stdout).text();
  expect(line).toContain("Opus");
  expect(line).toContain("5h 23% used");
  expect(line).toContain("·");
  expect(line).not.toContain("�");

  const cache = await readFile(paths.cache, "utf8");
  expect(cache).toContain('"used_percentage":23');
  expect(cache).not.toContain("must-not-be-cached");
  expect(cache).not.toContain("transcript");
}, SPAWN_TIMEOUT_MS);

test("POSIX bridge keeps the previous status line visible", async () => {
  if (windows) return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-posix-chain-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home, "linux");
  await Bun.write(paths.previous, "#!/bin/sh\necho ORIGINAL-LINE\n");
  await Bun.write(paths.script, buildPosixBridge("claude", groupCaches("claude", home), paths.previous));

  const processHandle = Bun.spawn({
    cmd: [process.execPath, "run", paths.script],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await processHandle.stdin.write(JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 23 } },
  }));
  // Deliberately not awaited. end() resolves once the pipe has been drained, which on
  // Windows means waiting out PowerShell's startup before this test moves on instead of
  // overlapping with it — enough to push these two past the default timeout. `exited`
  // below is a strictly stronger guarantee: a process that exited has read its stdin.
  void processHandle.stdin.end();
  expect(await processHandle.exited).toBe(0);
  expect(await new Response(processHandle.stdout).text()).toContain("ORIGINAL-LINE");
  // Chaining must not cost the capture: the cache is written before the handover.
  expect(await readFile(paths.cache, "utf8")).toContain('"used_percentage":23');
}, SPAWN_TIMEOUT_MS);

// A captured POSIX status line runs under cmd.exe, which does not expand `~` and
// resolves `bash` to WSL, whose home holds none of these files. The command fails
// to stderr, the bridge discards it, and the status line silently goes blank.
test("a captured POSIX status line is chained through Git Bash, other commands verbatim", async () => {
  if (!windows) return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-prev-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  await Bun.write(paths.config, JSON.stringify({
    statusLine: { type: "command", command: "bash ~/.claude/statusline-command.sh" },
  }));
  await installOfficialBridge("claude", home);

  const wrapper = await readFile(paths.previous, "utf8");
  expect(wrapper).toContain('set "LLMQ_PREV=bash ~/.claude/statusline-command.sh"');
  expect(wrapper).toContain("bin\\bash.exe");

  // A non-POSIX command has no reason to go through bash, and a quoted one cannot
  // survive `set "VAR=..."`. Both keep the previous verbatim behaviour.
  const plain = await mkdtemp(join(tmpdir(), "llm-quota-prev-plain-"));
  homes.push(plain);
  const plainPaths = officialBridgePaths("claude", plain);
  await Bun.write(plainPaths.config, JSON.stringify({
    statusLine: { type: "command", command: 'node "status line.js"' },
  }));
  await installOfficialBridge("claude", plain);
  expect(await readFile(plainPaths.previous, "utf8")).toBe('@echo off\r\nnode "status line.js"\r\n');
}, SPAWN_TIMEOUT_MS);

// The wrapper is only useful if cmd.exe, which is what the bridge spawns, can
// actually run a POSIX command through it.
test("the generated wrapper runs a POSIX command when cmd.exe executes it", async () => {
  if (!windows) return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-prevrun-"));
  homes.push(home);
  const script = join(home, "probe.sh");
  await Bun.write(script, "#!/bin/sh\necho CHAINED-LINE\n");
  const msys = "/" + script.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, drive) => drive.toLowerCase());

  const paths = officialBridgePaths("claude", home);
  await Bun.write(paths.config, JSON.stringify({
    statusLine: { type: "command", command: `bash ${msys}` },
  }));
  await installOfficialBridge("claude", home);

  const processHandle = Bun.spawn({
    cmd: [process.env.ComSpec ?? "cmd.exe", "/d", "/c", paths.previous],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await processHandle.stdin.write("{}");
  // Deliberately not awaited. end() resolves once the pipe has been drained, which on
  // Windows means waiting out PowerShell's startup before this test moves on instead of
  // overlapping with it — enough to push these two past the default timeout. `exited`
  // below is a strictly stronger guarantee: a process that exited has read its stdin.
  void processHandle.stdin.end();
  expect(await processHandle.exited).toBe(0);
  expect(await new Response(processHandle.stdout).text()).toContain("CHAINED-LINE");
}, SPAWN_TIMEOUT_MS);

// Forcing the console InputEncoding makes the reader surface the UTF-8 preamble
// as a leading U+FEFF. ConvertFrom-Json rejects it, and the script used to exit
// before writing the cache or printing anything at all.
test("PowerShell bridge parses a payload that arrives with a UTF-8 BOM", async () => {
  if (!windows) return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bom-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  await Bun.write(paths.script, buildPowerShellBridge("claude", groupCaches("claude", home), paths.previous));

  const processHandle = Bun.spawn({
    cmd: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.script],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await processHandle.stdin.write("﻿" + JSON.stringify({
    model: { display_name: "Opus" },
    rate_limits: { five_hour: { used_percentage: 41 } },
  }));
  // Deliberately not awaited. end() resolves once the pipe has been drained, which on
  // Windows means waiting out PowerShell's startup before this test moves on instead of
  // overlapping with it — enough to push these two past the default timeout. `exited`
  // below is a strictly stronger guarantee: a process that exited has read its stdin.
  void processHandle.stdin.end();
  expect(await processHandle.exited).toBe(0);
  expect(await readFile(paths.cache, "utf8")).toContain('"used_percentage":41');
}, SPAWN_TIMEOUT_MS);

// Hosts decode this stdout as UTF-8. Under the default ANSI/OEM console
// codepage the separator reaches the status line as U+FFFD.
test("PowerShell bridge emits UTF-8 so the separator survives the host", async () => {
  if (!windows) return;
  const home = await mkdtemp(join(tmpdir(), "llm-quota-encoding-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);
  await Bun.write(paths.script, buildPowerShellBridge("claude", groupCaches("claude", home), paths.previous));

  const processHandle = Bun.spawn({
    cmd: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.script],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await processHandle.stdin.write(JSON.stringify({
    model: { display_name: "Gemini 3.6 Flash (High)" },
    context_window: { used_percentage: 12 },
    rate_limits: { five_hour: { used_percentage: 23 } },
  }));
  // Deliberately not awaited. end() resolves once the pipe has been drained, which on
  // Windows means waiting out PowerShell's startup before this test moves on instead of
  // overlapping with it — enough to push these two past the default timeout. `exited`
  // below is a strictly stronger guarantee: a process that exited has read its stdin.
  void processHandle.stdin.end();
  expect(await processHandle.exited).toBe(0);

  const line = await new Response(processHandle.stdout).text();
  expect(line).toContain("·");
  expect(line).not.toContain("�");
}, SPAWN_TIMEOUT_MS);

// The wrapper is shared by everything on one settings file, so it used to capture every
// sibling's quota the moment any one of them was enabled. The sibling's card then showed
// live data nobody opted into, and — with no install metadata of its own — offered no
// way to turn it back off.
test("enabling one provider does not start capturing its group siblings", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);

  await installOfficialBridge("claude", home);
  const claudeOnly = await readFile(paths.script, "utf8");

  expect(claudeOnly).toContain(officialBridgePaths("claude", home).cache);
  expect(claudeOnly).not.toContain(officialBridgePaths("zai", home).cache);
  expect(claudeOnly).not.toContain("Z.ai GLM plugin sync");

  await installOfficialBridge("zai", home);
  const both = await readFile(paths.script, "utf8");
  expect(both).toContain(officialBridgePaths("zai", home).cache);
});

// Removing one member leaves the shared script alive for the others. Without rewriting
// it, the next status-line run recreated the cache file the teardown had just deleted.
test("removing one provider stops the shared wrapper writing its cache", async () => {
  const home = await mkdtemp(join(tmpdir(), "llm-quota-bridge-"));
  homes.push(home);
  const paths = officialBridgePaths("claude", home);

  await installOfficialBridge("claude", home);
  await installOfficialBridge("zai", home);
  await removeOfficialBridge("zai", home);

  const script = await readFile(paths.script, "utf8");
  expect(existsSync(paths.script)).toBe(true);
  expect(script).not.toContain(officialBridgePaths("zai", home).cache);
  expect(script).toContain(officialBridgePaths("claude", home).cache);
  expect(await officialBridgeInstalled("claude", home)).toBe(true);
});
