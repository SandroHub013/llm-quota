import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { existsSync } from "node:fs";

/** Safely read + parse a JSON file. Returns undefined on any failure. */
export async function readJson<T = any>(path: string): Promise<T | undefined> {
  try {
    if (!existsSync(path)) return undefined;
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

/** Best-effort JSON write (no-op su FS read-only, es. Vercel serverless). */
async function writeJson(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2));
  } catch (e: any) {
    console.warn("writeJson fallita (read-only?):", path, String(e?.message ?? e));
  }
}

const home = homedir();

export const paths = {
  claude: join(home, ".claude", ".credentials.json"),
  codex: join(home, ".codex", "auth.json"),
  opencode: join(home, ".local", "share", "opencode", "auth.json"),
  geminiOauth: join(home, ".gemini", "oauth_creds.json"),
  config: join(home, ".llm-quota", "config.json"),
  legacyConfig: join(home, ".webquota", "config.json"),
};

// --- Claude Code (~/.claude/.credentials.json) ---
export interface ClaudeOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}
export async function readClaude(): Promise<ClaudeOauth | undefined> {
  const j = await readJson<{ claudeAiOauth?: ClaudeOauth }>(paths.claude);
  return j?.claudeAiOauth;
}

// --- Codex / ChatGPT (~/.codex/auth.json) ---
export interface CodexAuth {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  last_refresh?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}
export async function readCodex(): Promise<CodexAuth | undefined> {
  return readJson<CodexAuth>(paths.codex);
}
export async function writeCodex(auth: CodexAuth): Promise<void> {
  await writeJson(paths.codex, auth);
}

// --- opencode auth store (holds several providers' keys/oauth) ---
export interface OpencodeEntry {
  type: "api" | "oauth";
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
}
export async function readOpencode(): Promise<Record<string, OpencodeEntry>> {
  return (await readJson<Record<string, OpencodeEntry>>(paths.opencode)) ?? {};
}

// --- Kimi Code (~/.kimi-code/credentials/kimi-code.json) ---
export interface KimiCreds {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // unix seconds
  scope?: string;
}
const kimiPath = join(home, ".kimi-code", "credentials", "kimi-code.json");
export async function readKimiCode(): Promise<KimiCreds | undefined> {
  return readJson<KimiCreds>(kimiPath);
}
export async function writeKimiCode(creds: KimiCreds): Promise<void> {
  await writeJson(kimiPath, creds);
}

// --- Gemini CLI oauth (~/.gemini/oauth_creds.json) ---
export interface GeminiOauth {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number; // ms epoch
}
export async function readGeminiOauth(): Promise<GeminiOauth | undefined> {
  return readJson<GeminiOauth>(paths.geminiOauth);
}
export async function writeGeminiOauth(creds: GeminiOauth): Promise<void> {
  await writeJson(paths.geminiOauth, creds);
}

// --- LLM Quota user config (~/.llm-quota/config.json) ---
export interface LlmQuotaConfig {
  keys: Record<string, string>; // providerId -> api key
}
export async function readLlmQuotaConfig(primary: string, legacy: string): Promise<LlmQuotaConfig> {
  return (await readJson<LlmQuotaConfig>(primary)) ?? (await readJson<LlmQuotaConfig>(legacy)) ?? { keys: {} };
}
export async function readConfig(): Promise<LlmQuotaConfig> {
  return readLlmQuotaConfig(paths.config, paths.legacyConfig);
}
export async function writeConfig(cfg: LlmQuotaConfig): Promise<void> {
  await writeJson(paths.config, cfg);
}

/** Decode a JWT payload without verifying (for reading plan claims). */
export function decodeJwt(token: string): Record<string, any> | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
