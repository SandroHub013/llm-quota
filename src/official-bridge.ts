import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJson } from "./credentials.js";

export type OfficialBridgeProvider = "claude" | "gemini" | "zai";
export type OfficialBridgeSource = "claude" | "antigravity" | "zai";

/**
 * Providers that share one settings file must also share one status-line script:
 * Claude Code and the Z.ai GLM plugin both read ~/.claude/settings.json, so two
 * separate wrappers would chain into each other and recurse forever.
 */
type BridgeGroup = "claude" | "antigravity";

const SOURCES: Record<OfficialBridgeProvider, OfficialBridgeSource> = {
  claude: "claude",
  gemini: "antigravity",
  zai: "zai",
};

const GROUPS: Record<OfficialBridgeProvider, BridgeGroup> = {
  claude: "claude",
  gemini: "antigravity",
  zai: "claude",
};

const GROUP_MEMBERS: Record<BridgeGroup, OfficialBridgeProvider[]> = {
  claude: ["claude", "zai"],
  antigravity: ["gemini"],
};

export interface OfficialBridgeSnapshot {
  version: 1;
  provider: OfficialBridgeSource;
  capturedAt: string;
  data: Record<string, any>;
}

interface BridgeMetadata {
  version: 1;
  provider: OfficialBridgeProvider;
  configPath: string;
  installedAt: string;
}

interface BridgeOrigin {
  version: 1;
  group: BridgeGroup;
  configPath: string;
  hadStatusLine: boolean;
  originalStatusLine?: unknown;
  capturedAt: string;
}

/**
 * Windows drives the status line through PowerShell; everywhere else the same
 * work is done by a script Bun runs, because a POSIX shell cannot read the JSON
 * the host pipes in without a JSON parser this project cannot assume is present.
 */
export function officialBridgePaths(
  provider: OfficialBridgeProvider,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
) {
  const source = SOURCES[provider];
  const group = GROUPS[provider];
  const root = join(home, ".llm-quota", "official");
  const windows = platform === "win32";
  return {
    source,
    group,
    root,
    windows,
    cache: join(root, `${source}.json`),
    script: join(root, `${group}-statusline-bridge.${windows ? "ps1" : "mjs"}`),
    previous: join(root, `${group}-previous-statusline.${windows ? "cmd" : "sh"}`),
    origin: join(root, `${group}-bridge-origin.json`),
    metadata: join(root, `${source}-bridge-install.json`),
    config: group === "antigravity"
      ? join(home, ".gemini", "antigravity-cli", "settings.json")
      : join(home, ".claude", "settings.json"),
  };
}

export async function readOfficialBridgeSnapshot(
  provider: OfficialBridgeProvider,
  home = homedir(),
): Promise<OfficialBridgeSnapshot | undefined> {
  const paths = officialBridgePaths(provider, home);
  const snapshot = await readJson<OfficialBridgeSnapshot>(paths.cache);
  if (
    snapshot?.version !== 1 ||
    snapshot.provider !== paths.source ||
    !snapshot.data ||
    typeof snapshot.data !== "object" ||
    !Number.isFinite(Date.parse(snapshot.capturedAt))
  ) return undefined;
  return snapshot;
}

/**
 * Whether this provider's status-line wrapper is currently installed.
 *
 * A settings file that cannot be parsed is not an answer of "no". It used to be:
 * the failure was swallowed into `undefined`, the card decided the bridge was off,
 * and the teardown button disappeared — leaving a user whose settings.json had a
 * typo with an installed wrapper and no way to remove it from the dashboard. The
 * error propagates, so the card states which file to repair instead.
 */
export async function officialBridgeInstalled(
  provider: OfficialBridgeProvider,
  home = homedir(),
): Promise<boolean> {
  const paths = officialBridgePaths(provider, home);
  const metadata = await readJson<BridgeMetadata>(paths.metadata);
  if (metadata?.version !== 1 || metadata.provider !== provider) return false;
  const settings = await readSettings(paths.config);
  return isOwnBridgeCommand(commandOf(settings.statusLine), paths.root);
}

/** Install an opt-in status-line wrapper while preserving the user's current command. */
export async function installOfficialBridge(
  provider: OfficialBridgeProvider,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<{ installed: true; configPath: string }> {
  const paths = officialBridgePaths(provider, home, platform);
  const settings = await readSettings(paths.config);
  const command = bridgeCommand(paths);
  const current = isRecord(settings.statusLine) ? settings.statusLine : undefined;
  const currentCommand = commandOf(current);
  // Never chain one of our own wrappers into another: that is what recursed.
  const alreadyBridged = isOwnBridgeCommand(currentCommand, paths.root);

  await mkdir(paths.root, { recursive: true });
  await mkdir(dirname(paths.config), { recursive: true });
  await migrateLegacyOrigin(paths, home);

  if (existsSync(paths.config)) {
    await copyFile(paths.config, `${paths.config}.llm-quota.bak`, constants.COPYFILE_EXCL).catch((error: any) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }

  if (!alreadyBridged) {
    if (currentCommand) await writeFile(paths.previous, previousWrapper(currentCommand, paths.windows), "utf8");
    else await rm(paths.previous, { force: true });
    const origin: BridgeOrigin = {
      version: 1,
      group: paths.group,
      configPath: paths.config,
      hadStatusLine: current != null,
      originalStatusLine: current,
      capturedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(paths.origin, origin);
  }

  const metadata: BridgeMetadata = {
    version: 1,
    provider,
    configPath: paths.config,
    installedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(paths.metadata, metadata);

  await writeFile(
    paths.script,
    buildBridgeScript(
      paths.group,
      groupCaches(paths.group, home, installedMembers(paths.group, home, provider)),
      paths.previous,
      paths.windows,
    ),
    "utf8",
  );
  settings.statusLine = { ...(current ?? {}), type: "command", command };
  await writeJsonAtomic(paths.config, settings);
  return { installed: true, configPath: paths.config };
}

/** Restore only the statusLine field captured at install time; keep later settings changes. */
export async function removeOfficialBridge(
  provider: OfficialBridgeProvider,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<{ installed: false; configPath: string }> {
  const paths = officialBridgePaths(provider, home, platform);
  const metadata = await readJson<BridgeMetadata>(paths.metadata);
  if (metadata?.version !== 1 || metadata.provider !== provider) throw new Error("bridge_metadata_missing");

  const settings = await readSettings(paths.config);
  if (!isOwnBridgeCommand(commandOf(settings.statusLine), paths.root)) {
    throw new Error("status_line_changed_after_bridge_install");
  }

  await Promise.all([rm(paths.metadata, { force: true }), rm(paths.cache, { force: true })]);

  // The shared wrapper stays until the last provider on this settings file leaves.
  // Rewrite it without this provider first, or the script the sibling keeps alive
  // would recreate the cache file just deleted above on its next run.
  const remaining = installedMembers(paths.group, home);
  if (remaining.length) {
    await writeFile(
      paths.script,
      buildBridgeScript(paths.group, groupCaches(paths.group, home, remaining), paths.previous, paths.windows),
      "utf8",
    );
    return { installed: false, configPath: paths.config };
  }

  const origin = await readJson<BridgeOrigin>(paths.origin);
  const restored = origin?.hadStatusLine && !isOwnBridgeCommand(commandOf(origin.originalStatusLine), paths.root)
    ? origin.originalStatusLine
    : undefined;
  if (restored !== undefined) settings.statusLine = restored;
  else delete settings.statusLine;
  await writeJsonAtomic(paths.config, settings);
  await Promise.all([
    rm(paths.script, { force: true }),
    rm(paths.previous, { force: true }),
    rm(paths.origin, { force: true }),
  ]);
  return { installed: false, configPath: paths.config };
}

/**
 * Pre-shared-script installs kept the restore target inside each provider's own
 * metadata file. Lift it into the group origin so uninstall still restores it.
 */
async function migrateLegacyOrigin(
  paths: ReturnType<typeof officialBridgePaths>,
  home: string,
): Promise<void> {
  if (existsSync(paths.origin)) return;
  for (const member of GROUP_MEMBERS[paths.group]) {
    const legacy = await readJson<BridgeMetadata & Partial<BridgeOrigin>>(
      officialBridgePaths(member, home).metadata,
    );
    if (legacy?.version !== 1 || typeof legacy.hadStatusLine !== "boolean") continue;
    if (isOwnBridgeCommand(commandOf(legacy.originalStatusLine), paths.root)) continue;
    await writeJsonAtomic(paths.origin, {
      version: 1,
      group: paths.group,
      configPath: paths.config,
      hadStatusLine: legacy.hadStatusLine,
      originalStatusLine: legacy.originalStatusLine,
      capturedAt: legacy.installedAt ?? new Date().toISOString(),
    } satisfies BridgeOrigin);
    return;
  }
}

export function groupCaches(
  group: BridgeGroup,
  home = homedir(),
  members: OfficialBridgeProvider[] = GROUP_MEMBERS[group],
): Record<OfficialBridgeSource, string> {
  const caches = {} as Record<OfficialBridgeSource, string>;
  for (const member of members) {
    const paths = officialBridgePaths(member, home);
    caches[paths.source] = paths.cache;
  }
  return caches;
}

/**
 * Members of this group the user has actually opted in for, plus `also` for the
 * install being performed right now (its metadata is not on disk yet).
 *
 * The script is shared, so without this filter enabling one provider would start
 * capturing quota for every sibling on the same settings file. The sibling's card
 * would then light up with live data the user never opted into, and — because its
 * own install metadata is missing — offer no way to switch it back off.
 */
function installedMembers(
  group: BridgeGroup,
  home: string,
  also?: OfficialBridgeProvider,
): OfficialBridgeProvider[] {
  return GROUP_MEMBERS[group].filter(
    (member) => member === also || existsSync(officialBridgePaths(member, home).metadata),
  );
}

export function buildBridgeScript(
  group: BridgeGroup,
  caches: Partial<Record<OfficialBridgeSource, string>>,
  previousCommandPath: string,
  windows = process.platform === "win32",
): string {
  return windows
    ? buildPowerShellBridge(group, caches, previousCommandPath)
    : buildPosixBridge(group, caches, previousCommandPath);
}

/**
 * The POSIX bridge is JavaScript rather than shell because it has to read the
 * JSON the host pipes in and cache a few fields out of it. `jq` and `python3`
 * are both absent often enough on a fresh macOS or Linux box to rule them out,
 * while Bun is already a hard requirement of this project — so the interpreter
 * baked into the status-line command is the very Bun running the install.
 *
 * It stays a readable file on disk on purpose: a tool that installs itself into
 * another client's config has to let the user read exactly what it installed.
 */
export function buildPosixBridge(
  group: BridgeGroup,
  caches: Partial<Record<OfficialBridgeSource, string>>,
  previousCommandPath: string,
): string {
  const captures: string[] = [];
  if (caches.claude) {
    captures.push(`const claudeData = state.rate_limits == null ? null : { rateLimits: state.rate_limits };
save(${jsLiteral(caches.claude)}, "claude", claudeData);`);
  }
  if (caches.zai) {
    // Only Z.ai's own plugin fields: state.rate_limits here is Claude's quota.
    captures.push(`const zaiData = state.glm_quota != null
  ? { glmQuota: state.glm_quota }
  : state.zai_quota != null
    ? { zaiQuota: state.zai_quota }
    : null;
save(${jsLiteral(caches.zai)}, "zai", zaiData);`);
  }
  if (caches.antigravity) {
    captures.push(`const antigravityData = state.quota == null
  ? null
  : { quota: state.quota, planTier: state.plan_tier };
save(${jsLiteral(caches.antigravity)}, "antigravity", antigravityData);`);
  }

  const summary = group === "antigravity"
    ? `if (state.quota != null && typeof state.quota === "object") {
  const remaining = Object.values(state.quota)
    .map((bucket) => Number(bucket == null ? NaN : bucket.remaining_fraction))
    .filter((value) => Number.isFinite(value));
  if (remaining.length) parts.push(\`quota \${Math.round(Math.min(...remaining) * 100)}% left\`);
}`
    : `const fiveHour = Number(state.rate_limits?.five_hour?.used_percentage);
if (Number.isFinite(fiveHour)) parts.push(\`5h \${Math.round(fiveHour)}% used\`);${caches.zai ? `
if (zaiData != null) parts.push("Z.ai GLM plugin sync");` : ""}`;

  return `// Generated by LLM Quota. Reads the JSON the official client already hands its
// status line, caches only the quota fields, and prints the line the host shows.
// Delete it by disabling the bridge from the dashboard.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function save(cachePath, provider, data) {
  if (data == null) return;
  const temporary = \`\${cachePath}.\${randomUUID()}.tmp\`;
  try {
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    const snapshot = { version: 1, provider, capturedAt: new Date().toISOString(), data };
    writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temporary, cachePath);
  } catch {
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

let payload = "";
try { payload = readFileSync(0, "utf8"); } catch {}
// Hosts are free to prefix the payload with a UTF-8 BOM, which JSON.parse rejects.
if (payload.charCodeAt(0) === 0xfeff) payload = payload.slice(1);
if (!payload.trim()) process.exit(0);

let state;
try { state = JSON.parse(payload); } catch { process.exit(0); }
if (state == null || typeof state !== "object") process.exit(0);

${captures.join("\n\n")}

const previousCommand = ${jsLiteral(previousCommandPath)};
if (existsSync(previousCommand)) {
  const chained = spawnSync("/bin/sh", [previousCommand], { input: payload, encoding: "utf8" });
  if (chained.stdout) process.stdout.write(chained.stdout);
  process.exit(0);
}

const parts = [];
if (typeof state.model?.display_name === "string") parts.push(state.model.display_name);
const context = Number(state.context_window?.used_percentage);
if (Number.isFinite(context)) parts.push(\`context \${Math.round(context)}%\`);
${summary}
if (!parts.length) parts.push("LLM Quota official sync");
process.stdout.write(parts.join(" \\u00b7 ") + "\\n");
`;
}

export function buildPowerShellBridge(
  group: BridgeGroup,
  caches: Partial<Record<OfficialBridgeSource, string>>,
  previousCommandPath: string,
): string {
  const captures: string[] = [];
  if (caches.claude) {
    captures.push(`$claudeData = if ($null -ne $state.rate_limits) { [ordered]@{ rateLimits = $state.rate_limits } } else { $null }
Save-Snapshot ${psLiteral(caches.claude)} 'claude' $claudeData`);
  }
  if (caches.zai) {
    // Only Z.ai's own plugin fields: $state.rate_limits here is Claude's quota.
    captures.push(`$zaiData = if ($null -ne $state.glm_quota) { [ordered]@{ glmQuota = $state.glm_quota } } elseif ($null -ne $state.zai_quota) { [ordered]@{ zaiQuota = $state.zai_quota } } else { $null }
Save-Snapshot ${psLiteral(caches.zai)} 'zai' $zaiData`);
  }
  if (caches.antigravity) {
    captures.push(`$antigravityData = if ($null -ne $state.quota) { [ordered]@{ quota = $state.quota; planTier = $state.plan_tier } } else { $null }
Save-Snapshot ${psLiteral(caches.antigravity)} 'antigravity' $antigravityData`);
  }

  const summary = group === "antigravity"
    ? `if ($null -ne $state.quota) {
  $remaining = @($state.quota.PSObject.Properties.Value | Where-Object { $null -ne $_.remaining_fraction } | ForEach-Object { [double]$_.remaining_fraction * 100 })
  if ($remaining.Count -gt 0) { $parts.Add("quota $([Math]::Round(($remaining | Measure-Object -Minimum).Minimum))% left") }
}`
    : `if ($null -ne $state.rate_limits.five_hour.used_percentage) {
  $parts.Add("5h $([Math]::Round([double]$state.rate_limits.five_hour.used_percentage))% used")
}${caches.zai ? `
if ($null -ne $zaiData) { $parts.Add('Z.ai GLM plugin sync') }` : ""}`;

  return `$ErrorActionPreference = 'SilentlyContinue'

# Hosts read this script's stdout as UTF-8. Windows PowerShell defaults the
# console streams to the ANSI/OEM codepage, which turns the separator and any
# non-ASCII model name into U+FFFD once the host decodes it.
try {
  $utf8 = New-Object Text.UTF8Encoding($false)
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch {}

function Save-Snapshot([string]$cachePath, [string]$providerName, $data) {
  if ($null -eq $data) { return }
  $temporary = $null
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cachePath) | Out-Null
    $snapshot = [ordered]@{
      version = 1
      provider = $providerName
      capturedAt = [DateTime]::UtcNow.ToString('o')
      data = $data
    }
    $json = $snapshot | ConvertTo-Json -Depth 12 -Compress
    $temporary = "$cachePath.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $cachePath -Force
  } catch {} finally {
    if ($null -ne $temporary -and (Test-Path -LiteralPath $temporary)) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
}

$payload = [Console]::In.ReadToEnd()
# Setting InputEncoding above makes the reader surface the UTF-8 preamble as a
# leading U+FEFF, which ConvertFrom-Json rejects as an invalid JSON primitive.
$payload = $payload.TrimStart([char]0xFEFF)
if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }

try { $state = $payload | ConvertFrom-Json } catch { exit 0 }

${captures.join("\n")}

$previousCommand = ${psLiteral(previousCommandPath)}
if (Test-Path -LiteralPath $previousCommand) {
  try {
    $shell = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
    $previousOutput = $payload | & $shell /d /s /c ""$previousCommand"" 2>$null
    if ($null -ne $previousOutput) { $previousOutput | ForEach-Object { Write-Output $_ } }
  } catch {}
  exit 0
}

$parts = New-Object 'System.Collections.Generic.List[string]'
if ($null -ne $state.model.display_name) { $parts.Add([string]$state.model.display_name) }
if ($null -ne $state.context_window.used_percentage) {
  $parts.Add("context $([Math]::Round([double]$state.context_window.used_percentage))%")
}
${summary}
if ($parts.Count -eq 0) { $parts.Add('LLM Quota official sync') }
Write-Output ($parts -join (' ' + [char]0x00B7 + ' '))
`;
}

/**
 * Wrap the status-line command the host had before us, so the bridge can chain it.
 *
 * The wrapper is a .cmd run by cmd.exe, but hosts run their status line through a
 * POSIX shell: a captured `bash ~/.claude/statusline.sh` breaks twice under cmd,
 * which neither expands `~` nor resolves `bash` the same way (on Windows `bash`
 * on PATH is usually WSL, whose `~` is a Linux home that holds none of these
 * files). The command then fails to stderr, which the bridge discards, and the
 * status line silently goes blank.
 *
 * So the captured command is handed to Git Bash when it is present, which expands
 * the tilde and resolves `bash` to itself. Git Bash is located from `git` on PATH
 * at run time rather than baked in, so the wrapper survives a Git upgrade. A
 * command containing a double quote cannot survive `set "VAR=..."`, and one that
 * is not POSIX in the first place has no reason to go through bash, so both fall
 * back to running the command verbatim, exactly as before.
 */
function previousWrapper(command: string, windows: boolean): string {
  // Off Windows the captured command already is a POSIX command and the shell
  // that runs this wrapper is the same one the host would have used, so it needs
  // none of the translation below.
  if (!windows) return `#!/bin/sh\n${command}\n`;
  if (command.includes('"') || !/^(bash|sh|zsh)\b/.test(command)) {
    return `@echo off\r\n${command}\r\n`;
  }
  return [
    "@echo off",
    "setlocal",
    `set "LLMQ_PREV=${command}"`,
    "for /f \"delims=\" %%G in ('where git 2^>nul') do if not defined LLMQ_BASH for %%H in (\"%%~dpG..\\bin\\bash.exe\") do if exist \"%%~fH\" set \"LLMQ_BASH=%%~fH\"",
    'if defined LLMQ_BASH ("%LLMQ_BASH%" -c "%LLMQ_PREV%") else (%LLMQ_PREV%)',
    "",
  ].join("\r\n");
}

/**
 * Spell the script path with forward slashes, and quote it only when it contains
 * whitespace. Hosts do not agree on how this command is parsed: Claude Code hands
 * it to a POSIX shell, while the Antigravity CLI splits the arguments itself and
 * passes them through verbatim. That rules out both obvious spellings — quotes
 * become part of the path under Antigravity and PowerShell fails with "Caratteri
 * non validi nel percorso", while an unquoted `C:\\Users\\...` loses every
 * backslash to the shell and PowerShell fails with "-File ... does not exist",
 * leaving the status line blank. PowerShell accepts forward slashes on Windows
 * and neither host rewrites them, so that spelling survives both; quoting is then
 * needed only for the paths that would otherwise split on a space.
 */
function bridgeCommand(paths: { script: string; windows: boolean }): string {
  // A backslash is a legal character in a POSIX filename, so only the Windows
  // spelling is rewritten.
  if (!paths.windows) {
    return `${quoteOnlyIfSpaced(bunExecutable())} run ${quoteOnlyIfSpaced(paths.script)}`;
  }
  const script = quoteOnlyIfSpaced(paths.script.replace(/\\/g, "/"));
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${script}`;
}

function quoteOnlyIfSpaced(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/**
 * Bake the absolute interpreter rather than relying on `bun` being on PATH: a
 * status line runs in whatever environment the host was started from, and a
 * desktop-launched editor routinely misses the shell profile that puts
 * ~/.bun/bin there. Resolved at install time, so a Bun upgrade in place keeps
 * working and a Bun that moved is fixed by re-enabling the bridge.
 */
function bunExecutable(): string {
  const executable = process.execPath;
  if (!executable || !/(^|[\\/])bun(\.exe)?$/i.test(executable)) {
    throw new Error("official_bridge_requires_bun");
  }
  return executable;
}

/**
 * True for any wrapper this tool generated, including quoted, backslash-spelled
 * and pre-shared-script layouts. Slashes are folded because the command now
 * spells the path with forward slashes while `root` is a native Windows path —
 * a mismatch here would make an install chain the bridge into itself.
 */
function isOwnBridgeCommand(command: string, root: string): boolean {
  if (!command) return false;
  const normalized = command.replace(/"/g, "").replace(/\\/g, "/").toLowerCase();
  return normalized.includes(root.replace(/\\/g, "/").toLowerCase())
    && /-statusline-bridge\.(ps1|mjs)\b/.test(normalized);
}

function commandOf(statusLine: unknown): string {
  if (!isRecord(statusLine)) return "";
  return typeof statusLine.command === "string" ? statusLine.command.trim() : "";
}

async function readSettings(path: string): Promise<Record<string, any>> {
  if (!existsSync(path)) return {};
  const text = stripBom(await readFile(path, "utf8"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // The parser's complaint names the offending line and column, which is the only
    // part of this that helps a user repair the file by hand.
    throw new Error(`invalid_settings_json: ${path}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`invalid_settings_json: ${path}`, {
      cause: new Error(`expected a JSON object, found ${Array.isArray(parsed) ? "an array" : typeof parsed}`),
    });
  }
  return parsed;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path).catch(async () => {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rm(temporary, { force: true });
  });
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** JSON is a subset of JS literal syntax, so it escapes Windows paths correctly too. */
function jsLiteral(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
