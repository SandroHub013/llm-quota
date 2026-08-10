import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cachedFile, pruneCache, type FileCacheEntry } from "./cache.js";
import { walk } from "./files.js";
import { scanClaude, type ClaudeMessage } from "./parsers/claude.js";
import { scanCodex } from "./parsers/codex.js";
import { scanKimi } from "./parsers/kimi.js";
import { scanNikcli } from "./parsers/nikcli.js";
import { scanOpenCode } from "./parsers/opencode.js";
import { scanPi } from "./parsers/pi.js";
import { totalOf } from "./rows.js";
import { summarizeUsageRows } from "./summarize.js";
import {
  SOURCE_NAMES,
  type CodexFileUsage,
  type RawUsageRow,
  type UsagePaths,
  type UsageSourceId,
  type UsageSourceStatus,
  type UsageSummary,
} from "./types.js";

const codexCache = new Map<string, FileCacheEntry<CodexFileUsage>>();
const claudeCache = new Map<string, FileCacheEntry<ClaudeMessage[]>>();
const kimiCache = new Map<string, FileCacheEntry<RawUsageRow[]>>();
const piCache = new Map<string, FileCacheEntry<RawUsageRow[]>>();
const primeCache = new Map<string, FileCacheEntry<RawUsageRow[]>>();

const defaultPaths = (): UsagePaths => {
  const home = homedir();
  return {
    codex: join(home, ".codex", "sessions"),
    codexArchived: join(home, ".codex", "archived_sessions"),
    claude: join(home, ".claude", "projects"),
    kimi: join(home, ".kimi-code", "sessions"),
    opencodeDb: join(home, ".local", "share", "opencode", "opencode.db"),
    pi: join(home, ".pi", "agent", "sessions"),
    prime: join(home, ".prime", "agent", "sessions"),
    primeArtifacts: join(home, ".prime", "agent", "session-artifacts"),
    // NikCLI follows the platform data directory instead of a dotfile in $HOME.
    nikcliDb: process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "nikcli", "nikcli.db")
      : join(home, ".local", "share", "nikcli", "nikcli.db"),
  };
};

/**
 * One ledger source: gather its raw rows into `raw` and report the resulting status.
 * A thrown error abandons only this source and is reported as "error" by the caller,
 * keeping the rows already collected from every other source.
 */
interface SourceCollector {
  id: UsageSourceId;
  collect: (paths: UsagePaths, raw: RawUsageRow[]) => Promise<UsageSourceStatus>;
}

const SOURCE_COLLECTORS: SourceCollector[] = [
  {
    id: "codex",
    collect: async (paths, raw) => {
      const files = [
        ...await walk(paths.codex, ".jsonl"),
        ...(paths.codexArchived ? await walk(paths.codexArchived, ".jsonl") : []),
      ];
      pruneCache(codexCache, files);
      const sessions = new Map<string, CodexFileUsage>();
      for (const file of files) {
        const usage = await cachedFile(codexCache, file, () => scanCodex(file));
        if (!usage) continue;
        const current = sessions.get(usage.sessionId);
        const tokens = usage.rows.reduce((sum, row) => sum + totalOf(row), 0);
        const currentTokens = current?.rows.reduce((sum, row) => sum + totalOf(row), 0) ?? -1;
        if (!current || tokens >= currentTokens) sessions.set(usage.sessionId, usage);
      }
      for (const session of sessions.values()) raw.push(...session.rows);
      return {
        id: "codex",
        name: SOURCE_NAMES.codex,
        status: files.length ? "ok" : "missing",
        files: files.length,
      };
    },
  },
  {
    id: "claude",
    collect: async (paths, raw) => {
      const files = await walk(paths.claude, ".jsonl");
      pruneCache(claudeCache, files);
      const messages = new Map<string, RawUsageRow>();
      for (const file of files) {
        const records = await cachedFile(claudeCache, file, () => scanClaude(file));
        for (const { id, row } of records ?? []) {
          const current = messages.get(id);
          const hasMoreTokens = !current || totalOf(row) > totalOf(current);
          const isCanonicalSubagent = current && totalOf(row) === totalOf(current) &&
            current.agent === "main" && row.agent === "subagent";
          if (hasMoreTokens || isCanonicalSubagent) messages.set(id, row);
        }
      }
      raw.push(...messages.values());
      return {
        id: "claude",
        name: SOURCE_NAMES.claude,
        status: files.length ? "ok" : "missing",
        files: files.length,
      };
    },
  },
  {
    id: "kimi",
    collect: async (paths, raw) => {
      const files = await walk(paths.kimi, "wire.jsonl");
      pruneCache(kimiCache, files);
      for (const file of files) {
        raw.push(...(await cachedFile(kimiCache, file, () => scanKimi(file)) ?? []));
      }
      return {
        id: "kimi",
        name: SOURCE_NAMES.kimi,
        status: files.length ? "ok" : "missing",
        files: files.length,
      };
    },
  },
  {
    id: "opencode",
    collect: async (paths, raw) => {
      const rows = await scanOpenCode(paths.opencodeDb);
      raw.push(...rows);
      return {
        id: "opencode",
        name: SOURCE_NAMES.opencode,
        status: existsSync(paths.opencodeDb) ? "ok" : "missing",
        files: existsSync(paths.opencodeDb) ? 1 : 0,
      };
    },
  },
  {
    id: "pi",
    collect: async (paths, raw) => {
      const files = await walk(paths.pi, ".jsonl");
      pruneCache(piCache, files);
      for (const file of files) {
        raw.push(...(await cachedFile(piCache, file, () => scanPi(file, "pi")) ?? []));
      }
      return {
        id: "pi",
        name: SOURCE_NAMES.pi,
        status: files.length ? "ok" : "missing",
        files: files.length,
      };
    },
  },
  {
    id: "prime",
    collect: async (paths, raw) => {
      const files = [
        ...await walk(paths.prime, ".jsonl"),
        ...(paths.primeArtifacts ? await walk(paths.primeArtifacts, ".jsonl") : []),
      ];
      pruneCache(primeCache, files);
      for (const file of files) {
        raw.push(...(await cachedFile(primeCache, file, () => scanPi(file, "prime")) ?? []));
      }
      return {
        id: "prime",
        name: SOURCE_NAMES.prime,
        status: files.length ? "ok" : "missing",
        files: files.length,
      };
    },
  },
  {
    id: "nikcli",
    collect: async (paths, raw) => {
      raw.push(...await scanNikcli(paths.nikcliDb));
      return {
        id: "nikcli",
        name: SOURCE_NAMES.nikcli,
        status: existsSync(paths.nikcliDb) ? "ok" : "missing",
        files: existsSync(paths.nikcliDb) ? 1 : 0,
      };
    },
  },
];

export async function collectUsage(paths: UsagePaths = defaultPaths()): Promise<UsageSummary> {
  const raw: RawUsageRow[] = [];
  const sources: UsageSourceStatus[] = [];

  for (const { id, collect } of SOURCE_COLLECTORS) {
    try {
      sources.push(await collect(paths, raw));
    } catch {
      sources.push({ id, name: SOURCE_NAMES[id], status: "error" });
    }
  }

  sources.push({
    id: "gemini",
    name: "Gemini",
    status: "unsupported",
    message: "The local CLI history does not expose reliable token counters.",
  });
  // Hermes is a desktop app whose profile directory holds only Chromium state: no
  // transcript, no token counter. Its spend stays server side, out of this ledger.
  sources.push({
    id: "hermes",
    name: "Hermes",
    status: "unsupported",
    message: "The desktop app stores no local token record.",
  });
  return summarizeUsageRows(raw, sources);
}
