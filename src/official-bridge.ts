import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJson } from "./credentials.js";

export type OfficialBridgeProvider = "claude" | "gemini" | "zai";

export interface OfficialBridgeSnapshot {
  version: 1;
  provider: "claude" | "antigravity" | "zai";
  capturedAt: string;
  data: Record<string, any>;
}

interface BridgeMetadata {
  version: 1;
  provider: OfficialBridgeProvider;
  configPath: string;
  hadStatusLine: boolean;
  originalStatusLine?: unknown;
  installedAt: string;
}

export function officialBridgePaths(provider: OfficialBridgeProvider, home = homedir()) {
  const source = provider === "gemini" ? "antigravity" : provider;
  const root = join(home, ".llm-quota", "official");
  return {
    source,
    root,
    cache: join(root, `${source}.json`),
    script: join(root, `${source}-statusline-bridge.ps1`),
    previous: join(root, `${source}-previous-statusline.cmd`),
    metadata: join(root, `${source}-bridge-install.json`),
    config: provider === "gemini"
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
  const expected = provider === "gemini" ? "antigravity" : provider;
  if (
    snapshot?.version !== 1 ||
    snapshot.provider !== expected ||
    !snapshot.data ||
    typeof snapshot.data !== "object" ||
    !Number.isFinite(Date.parse(snapshot.capturedAt))
  ) return undefined;
  return snapshot;
}

export async function officialBridgeInstalled(
  provider: OfficialBridgeProvider,
  home = homedir(),
): Promise<boolean> {
  const paths = officialBridgePaths(provider, home);
  const settings = await readSettings(paths.config).catch(() => undefined);
  return settings?.statusLine?.command === bridgeCommand(paths.script);
}

/** Install an opt-in status-line wrapper while preserving the user's current command. */
export async function installOfficialBridge(
  provider: OfficialBridgeProvider,
  home = homedir(),
): Promise<{ installed: true; configPath: string }> {
  if (process.platform !== "win32") {
    throw new Error("official_bridge_windows_prototype");
  }

  const paths = officialBridgePaths(provider, home);
  const settings = await readSettings(paths.config);
  const command = bridgeCommand(paths.script);
  const current = isRecord(settings.statusLine) ? settings.statusLine : undefined;
  const alreadyInstalled = current?.command === command;

  await mkdir(paths.root, { recursive: true });
  await mkdir(dirname(paths.config), { recursive: true });

  if (existsSync(paths.config)) {
    await copyFile(paths.config, `${paths.config}.llm-quota.bak`, constants.COPYFILE_EXCL).catch((error: any) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }

  if (!alreadyInstalled) {
    const previousCommand = typeof current?.command === "string" ? current.command.trim() : "";
    if (previousCommand) {
      await writeFile(paths.previous, `@echo off\r\n${previousCommand}\r\n`, "utf8");
    }
    const metadata: BridgeMetadata = {
      version: 1,
      provider,
      configPath: paths.config,
      hadStatusLine: current != null,
      originalStatusLine: current,
      installedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(paths.metadata, metadata);
  }

  await writeFile(paths.script, buildPowerShellBridge(provider, paths.cache, paths.previous), "utf8");
  settings.statusLine = { ...(current ?? {}), type: "command", command };
  await writeJsonAtomic(paths.config, settings);
  return { installed: true, configPath: paths.config };
}

/** Restore only the statusLine field captured at install time; keep later settings changes. */
export async function removeOfficialBridge(
  provider: OfficialBridgeProvider,
  home = homedir(),
): Promise<{ installed: false; configPath: string }> {
  const paths = officialBridgePaths(provider, home);
  const metadata = await readJson<BridgeMetadata>(paths.metadata);
  if (metadata?.version !== 1 || metadata.provider !== provider) throw new Error("bridge_metadata_missing");

  const settings = await readSettings(paths.config);
  if (settings.statusLine?.command !== bridgeCommand(paths.script)) {
    throw new Error("status_line_changed_after_bridge_install");
  }
  if (metadata.hadStatusLine) settings.statusLine = metadata.originalStatusLine;
  else delete settings.statusLine;
  await writeJsonAtomic(paths.config, settings);
  await Promise.all([
    rm(paths.script, { force: true }),
    rm(paths.previous, { force: true }),
    rm(paths.metadata, { force: true }),
    rm(paths.cache, { force: true }),
  ]);
  return { installed: false, configPath: paths.config };
}

export function buildPowerShellBridge(
  provider: OfficialBridgeProvider,
  cachePath: string,
  previousCommandPath: string,
): string {
  const source = provider === "gemini" ? "antigravity" : provider;
  const dataSelector = provider === "claude"
    ? `$officialData = if ($null -ne $state.rate_limits) { [ordered]@{ rateLimits = $state.rate_limits } } else { $null }`
    : provider === "gemini"
      ? `$officialData = if ($null -ne $state.quota) { [ordered]@{ quota = $state.quota; planTier = $state.plan_tier } } else { $null }`
      : `$officialData = if ($null -ne $state.glm_quota) { [ordered]@{ glmQuota = $state.glm_quota } } elseif ($null -ne $state.zai_quota) { [ordered]@{ zaiQuota = $state.zai_quota } } elseif ($null -ne $state.rate_limits) { [ordered]@{ rateLimits = $state.rate_limits } } else { $null }`;

  return `$ErrorActionPreference = 'SilentlyContinue'
$payload = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payload)) { exit 0 }

try { $state = $payload | ConvertFrom-Json } catch { exit 0 }
${dataSelector}

if ($null -ne $officialData) {
  try {
    $cachePath = ${psLiteral(cachePath)}
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cachePath) | Out-Null
    $snapshot = [ordered]@{
      version = 1
      provider = ${psLiteral(source)}
      capturedAt = [DateTime]::UtcNow.ToString('o')
      data = $officialData
    }
    $json = $snapshot | ConvertTo-Json -Depth 12 -Compress
    $temporary = "$cachePath.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $cachePath -Force
  } catch {}
}

$previousCommand = ${psLiteral(previousCommandPath)}
if (Test-Path -LiteralPath $previousCommand) {
  try {
    $shell = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' }
    $previousOutput = $payload | & $shell /d /s /c "\"$previousCommand\"" 2>$null
    if ($null -ne $previousOutput) { $previousOutput | ForEach-Object { Write-Output $_ } }
  } catch {}
  exit 0
}

$parts = New-Object 'System.Collections.Generic.List[string]'
if ($null -ne $state.model.display_name) { $parts.Add([string]$state.model.display_name) }
if ($null -ne $state.context_window.used_percentage) {
  $parts.Add("context $([Math]::Round([double]$state.context_window.used_percentage))%")
}
if (${provider === "claude" ? "$null -ne $state.rate_limits.five_hour.used_percentage" : provider === "gemini" ? "$null -ne $state.quota" : "$null -ne $officialData"}) {
  ${provider === "claude"
    ? `$parts.Add("5h $([Math]::Round([double]$state.rate_limits.five_hour.used_percentage))% used")`
    : provider === "gemini"
      ? `$remaining = @($state.quota.PSObject.Properties.Value | Where-Object { $null -ne $_.remaining_fraction } | ForEach-Object { [double]$_.remaining_fraction * 100 })
  if ($remaining.Count -gt 0) { $parts.Add("quota $([Math]::Round(($remaining | Measure-Object -Minimum).Minimum))% left") }`
      : `$parts.Add("Z.ai GLM plugin sync")`}
}
if ($parts.Count -eq 0) { $parts.Add('LLM Quota official sync') }
Write-Output ($parts -join ' \u00b7 ')
`;
}

function bridgeCommand(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${script}`;
}

async function readSettings(path: string): Promise<Record<string, any>> {
  if (!existsSync(path)) return {};
  const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("settings_not_object");
    return parsed;
  } catch {
    throw new Error(`invalid_settings_json: ${path}`);
  }
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

function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
