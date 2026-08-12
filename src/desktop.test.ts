import { expect, test } from "bun:test";
import { bunTargetFor, parseHostTriple } from "../scripts/build-sidecar.js";

const read = (path: string) => Bun.file(path).text();

/**
 * Three files carry the version, and only one of them is the one anyone remembers to
 * bump. A desktop bundle stamped with a version the package never had is not a
 * cosmetic problem: it is what the installer writes into Add/Remove Programs, and what
 * a user reads back when reporting a bug.
 */
test("the package, the bundle and the crate agree on the version", async () => {
  const version = JSON.parse(await read("package.json")).version;
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);

  expect(JSON.parse(await read("src-tauri/tauri.conf.json")).version).toBe(version);
  expect(await read("src-tauri/Cargo.toml")).toContain(`\nversion = "${version}"\n`);
});

test("the host triple is read from rustc's own report", () => {
  const report = "rustc 1.96.1 (31fca3adb 2026-06-26)\nbinary: rustc\nhost: x86_64-pc-windows-msvc\nrelease: 1.96.1\n";
  expect(parseHostTriple(report)).toBe("x86_64-pc-windows-msvc");
  expect(() => parseHostTriple("rustc 1.96.1")).toThrow(/host triple/);
});

/**
 * A triple with no Bun target would build the host's architecture under a cross-built
 * name — a bundle that installs cleanly and then fails to launch. The mapping has to
 * cover every target the release matrix names, and the matrix is where new platforms
 * get added, so read it rather than restating it.
 */
test("every release target maps to a Bun compile target", async () => {
  const workflow = await read(".github/workflows/release.yml");
  const targets = [...workflow.matchAll(/^\s*- \{ os: \S+, target: (\S+),/gm)].map((match) => match[1]!);

  expect(targets.length).toBeGreaterThanOrEqual(4);
  for (const target of targets) {
    expect(() => bunTargetFor(target), `${target} has no Bun target`).not.toThrow();
  }
  expect(() => bunTargetFor("sparc64-unknown-linux-gnu")).toThrow(/BUN_TARGETS/);
});

/**
 * Tauri finds the sidecar by appending the target triple to the externalBin path. The
 * name the build script writes and the name the bundler looks for are set in two
 * different files; when they drift, the bundle simply ships without a server.
 */
test("the bundle and the build script agree on the sidecar name", async () => {
  const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
  expect(config.bundle.externalBin).toEqual(["binaries/llm-quota-server"]);
  expect(await read("scripts/build-sidecar.ts")).toContain("`llm-quota-server-${triple}${suffix}`");
});

/**
 * The splash screen is bundled into the desktop binary and shown before any server
 * exists. The dashboard's zero-third-party-request promise covers it too — and here it
 * is not even reachable over the network to be caught later.
 */
test("the splash screen loads nothing remote", async () => {
  const splash = await read("src-tauri/splash/index.html");
  const remote = [...splash.matchAll(/\bhttps?:\/\/([^\s"'`)]+)/g)]
    .map((match) => match[1]!)
    .filter((host) => !host.startsWith("www.w3.org"));
  expect(remote).toEqual([]);
});
