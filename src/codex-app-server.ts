import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

export interface CodexAppServerResult {
  /** Whatever Codex answered with. `providers/codex.ts` is what reads its shape. */
  rateLimits: unknown;
}

/**
 * Where `codex` is, or nothing.
 *
 * Resolved here rather than left to the shell because the shell's answer is a sentence
 * in the user's own language, written in the console's OEM code page — an Italian
 * Windows put "'codex' non � riconosciuto" on the dashboard, mojibake and all, and
 * cmd exits 1 for it exactly as it does for a Codex that started and failed. Two very
 * different answers, indistinguishable at the surface.
 *
 * Looking on PATH ourselves gives the honest one: not installed, or installed and
 * broken. It also survives the case this app actually hits — a desktop shell launched
 * with the PATH the session had at login, missing what was installed after it.
 */
export function resolveCodex(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const directories = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `codex${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `.cmd` and `.bat` are scripts: Windows cannot execute them without its interpreter. */
const needsShell = (path: string) => /\.(cmd|bat)$/i.test(path);

/** One JSON-RPC frame, as far as this client cares: an id, and one of the two halves. */
interface RpcMessage {
  id?: unknown;
  error?: { message?: unknown };
  result?: unknown;
}

/**
 * Read the current ChatGPT limits through Codex's documented local app-server.
 * Authentication and token refresh remain entirely owned by Codex.
 */
export function readCodexRateLimits(timeoutMs = 8_000): Promise<CodexAppServerResult> {
  return new Promise((resolve, reject) => {
    const executable = resolveCodex();
    if (!executable) {
      reject(new Error("codex_app_server_unavailable: codex is not on this PATH"));
      return;
    }

    const child = needsShell(executable)
      // `call` with the path as its own argument, rather than one quoted string: cmd
      // reads `/c "…"` by its own rules, and a command line that begins with a quote is
      // taken apart in a way that makes an absolute path unrecognisable to it.
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "call", executable, "app-server"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(executable, ["app-server"], {
          stdio: ["pipe", "pipe", "pipe"],
        });

    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, result?: CodexAppServerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      const killTimer = setTimeout(() => child.kill(), 250);
      killTimer.unref?.();
      if (error) reject(error);
      else resolve(result!);
    };

    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-1_000);
    });

    child.on("error", (error) => finish(new Error(`codex_app_server_unavailable: ${error.message}`)));
    child.on("exit", (code) => {
      if (settled) return;
      const detail = cleanStderr(stderr) || `exit_${code ?? "unknown"}`;
      finish(new Error(`codex_app_server_closed: ${detail}`));
    });

    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        // Deliberate: the protocol is JSON-RPC over stdout, but Codex is free to
        // print banners, upgrade notices and progress there too. A line that is
        // not JSON is not addressed to us. The request still fails loudly through
        // the timeout if the reply never arrives.
        return;
      }

      if (message.id === 0) {
        if (message.error) {
          finish(new Error(`codex_initialize_failed: ${String(message.error.message ?? "unknown")}`));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 1, params: {} });
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          finish(new Error(`codex_rate_limits_failed: ${String(message.error.message ?? "unknown")}`));
          return;
        }
        finish(undefined, { rateLimits: message.result });
      }
    });

    const timer = setTimeout(() => {
      const detail = cleanStderr(stderr);
      finish(new Error(`codex_app_server_timeout${detail ? `: ${detail}` : ""}`));
    }, timeoutMs);

    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "llm_quota",
          title: "LLM Quota",
          version: "0.2.0",
        },
      },
    });
  });
}

function cleanStderr(value: string): string {
  return value
    // The escape is the point: Codex colours its errors and this string is rendered
    // in a card, where the raw codes would show up as `[31m`.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
