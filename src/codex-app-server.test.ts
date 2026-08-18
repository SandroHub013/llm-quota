/**
 * The Codex app-server client, tested against a Codex that does what the real one does.
 *
 * This module speaks JSON-RPC over a spawned process's stdio, and it was the least
 * covered file in the repository — two per cent of its lines — for the provider the
 * project leads with. Mocking `spawn` would have exercised the mock; instead a fake
 * `codex` goes on PATH and the client talks to it the way it talks to the real one,
 * through a real pipe, with real line buffering.
 *
 * The fake is driven by FAKE_CODEX, so one script covers every reply the client has a
 * branch for: the answer, the two documented errors, the banner lines Codex prints on
 * stdout that are not addressed to us, a process that dies without replying, and one
 * that says nothing at all.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readCodexRateLimits, resolveCodex } from "./codex-app-server.js";

const RATE_LIMITS = {
  primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 1_200 },
  secondary: { used_percent: 7, window_minutes: 10_080, resets_in_seconds: 90_000 },
};

/**
 * A Codex that answers over stdin/stdout. Written as a script rather than a mock so the
 * client's own readline, its stdin writes and its process handling all run for real.
 */
const FAKE = `
const mode = process.env.FAKE_CODEX || "ok";
const say = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

if (mode === "banner") {
  // Codex prints upgrade notices and progress on the same stream as the protocol.
  process.stdout.write("codex 1.4.0 — a new version is available\\n");
  process.stdout.write("{ not json after all\\n");
}
if (mode === "dies") {
  process.stderr.write("\\u001b[31merror\\u001b[0m: not logged in\\n");
  process.exit(3);
}
if (mode === "silent") setTimeout(() => {}, 60_000);

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim() || mode === "silent") continue;
    const message = JSON.parse(line);

    if (message.method === "initialize") {
      if (mode === "initialize-error") say({ id: 0, error: { message: "handshake refused" } });
      else say({ id: 0, result: { userAgent: "codex" } });
    }

    if (message.method === "account/rateLimits/read") {
      if (mode === "limits-error") say({ id: 1, error: { message: "not authenticated" } });
      else if (mode === "limits-error-blank") say({ id: 1, error: {} });
      else say({ id: 1, result: ${JSON.stringify(RATE_LIMITS)} });
    }
  }
});
`;

let root: string;
let originalPath: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "llm-quota-fake-codex-"));
  const script = join(root, "fake-codex.js");
  await writeFile(script, FAKE);

  // The client spawns `codex` through cmd.exe on Windows and directly everywhere else,
  // so the fake has to be findable as a command under both.
  if (process.platform === "win32") {
    await writeFile(join(root, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const shim = join(root, "codex");
    await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(shim, 0o755);
  }

  originalPath = process.env.PATH;
  process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
});

afterAll(async () => {
  process.env.PATH = originalPath;
  delete process.env.FAKE_CODEX;
  await rm(root, { recursive: true, force: true });
});

test("the handshake is completed and the limits come back", async () => {
  process.env.FAKE_CODEX = "ok";
  const result = await readCodexRateLimits(10_000);

  expect(result.rateLimits).toEqual(RATE_LIMITS);
});

/**
 * Codex is free to print on stdout: version notices, progress, whatever a future
 * release adds. A line that is not JSON is not addressed to this client, and treating
 * one as a protocol error would break the read for a cosmetic reason.
 */
test("banner lines on the protocol stream are ignored, not fatal", async () => {
  process.env.FAKE_CODEX = "banner";
  const result = await readCodexRateLimits(10_000);

  expect(result.rateLimits).toEqual(RATE_LIMITS);
});

test("a refused handshake is reported as the handshake, not as the read", async () => {
  process.env.FAKE_CODEX = "initialize-error";

  expect(readCodexRateLimits(10_000)).rejects.toThrow("codex_initialize_failed: handshake refused");
});

test("a refused read carries the reason Codex gave", async () => {
  process.env.FAKE_CODEX = "limits-error";

  expect(readCodexRateLimits(10_000)).rejects.toThrow("codex_rate_limits_failed: not authenticated");
});

// An error object with no message still has to end the promise: a silent one would hang
// until the timeout and blame the wrong thing.
test("a refused read with no reason still fails, as unknown", async () => {
  process.env.FAKE_CODEX = "limits-error-blank";

  expect(readCodexRateLimits(10_000)).rejects.toThrow("codex_rate_limits_failed: unknown");
});

/**
 * The common real failure: Codex is installed but nobody is logged in, so it prints to
 * stderr and exits. The colour codes it writes are stripped, because this string is
 * rendered in the dashboard's card.
 */
test("a process that dies is reported with its stderr, stripped of colour", async () => {
  process.env.FAKE_CODEX = "dies";

  const failure = await readCodexRateLimits(10_000).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("codex_app_server_closed");
  expect((failure as Error).message).toContain("error: not logged in");
  expect((failure as Error).message).not.toContain("[");
});

test("a Codex that never answers fails on the timeout rather than hanging", async () => {
  process.env.FAKE_CODEX = "silent";

  expect(readCodexRateLimits(300)).rejects.toThrow("codex_app_server_timeout");
});

/**
 * No Codex on PATH at all. Windows reaches this through cmd.exe, which exists and exits
 * non-zero rather than failing to spawn, so the two paths report it differently — both
 * are the same fact to the caller: there is nothing to talk to.
 */
/**
 * Resolution is what separates "not installed" from "installed and failing", and the two
 * get different instructions on the card. It is done here rather than left to the shell
 * because the shell answers in the user's own language, in the console's code page:
 * "'codex' non è riconosciuto" arrived on a dashboard as mojibake, and cmd exits 1 for it
 * exactly as it does for a Codex that started and crashed.
 */
test("codex is found on PATH by name and extension", () => {
  const found = resolveCodex({ PATH: root, PATHEXT: ".COM;.EXE;.BAT;.CMD" });

  expect(found).toBeDefined();
  expect(found!.startsWith(root)).toBe(true);
});

/**
 * `ComSpec` names the program this code hands a command line to, and it is an ordinary
 * environment variable — anything that starts this process can point it elsewhere. The
 * interpreter comes from the Windows directory instead, which a caller does not choose.
 */
test("the interpreter is not taken from the environment", async () => {
  const source = await Bun.file("src/codex-app-server.ts").text();

  expect(source).toContain('join(root, "System32", "cmd.exe")');
  // ComSpec survives only as the last fallback, when the Windows directory is unreadable.
  expect(source.indexOf("process.env.ComSpec")).toBeGreaterThan(source.indexOf("SystemRoot"));
  expect(source).not.toContain('spawn(process.env.ComSpec');
});

test("an empty PATH resolves nothing rather than guessing", () => {
  expect(resolveCodex({ PATH: "", PATHEXT: ".EXE" })).toBeUndefined();
  expect(resolveCodex({})).toBeUndefined();
});

test("no Codex at all is reported as missing, not as broken", async () => {
  const withoutFake = process.env.PATH;
  process.env.PATH = join(root, "empty");
  try {
    const failure = await readCodexRateLimits(5_000).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    // Not installed and installed-but-failing are different answers, and the card gives
    // different instructions for them: one says install Codex, the other says try later.
    expect((failure as Error).message).toContain("codex_app_server_unavailable");
  } finally {
    process.env.PATH = withoutFake;
  }
});

test("a Codex that never answers fails on the timeout rather than hanging", async () => {
  process.env.FAKE_CODEX = "silent";

  expect(readCodexRateLimits(300)).rejects.toThrow("codex_app_server_timeout");
});

/**
 * No Codex on PATH at all. Windows reaches this through cmd.exe, which exists and exits
 * non-zero rather than failing to spawn, so the two paths report it differently — both
 * are the same fact to the caller: there is nothing to talk to.
 */

