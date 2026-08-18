import { expect, test } from "bun:test";
import { bunTargetFor, parseHostTriple, windowsBranding } from "../scripts/build-sidecar.js";

// Line endings are a checkout artifact, not content: git hands Windows runners CRLF
// for the same commit Linux gets as LF, and every assertion below compares file text.
const read = async (path: string) => (await Bun.file(path).text()).replaceAll("\r\n", "\n");

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
 * A compiled Bun binary carries Bun's own mascot and no publisher unless told
 * otherwise, and this one is published as a release asset rather than only embedded
 * in the bundle. An unsigned executable with no company name is also the worst case
 * for the SmartScreen prompt users already have to click through.
 */
test("the Windows server executable is branded", async () => {
  const manifest = JSON.parse(await read("package.json"));
  const flags = windowsBranding(manifest.version, manifest.description);

  expect(flags).toContain("--windows-title=LLM Quota");
  expect(flags).toContain("--windows-publisher=Alessandro Boni");
  expect(flags).toContain(`--windows-description=${manifest.description}`);
  // Windows wants four components; the package carries three.
  expect(flags).toContain(`--windows-version=${manifest.version}.0`);

  const icon = flags.find((flag) => flag.startsWith("--windows-icon="))?.slice("--windows-icon=".length);
  expect(icon).toBeDefined();
  expect(await Bun.file(icon!).exists(), `${icon} is missing`).toBe(true);
});

/**
 * Windows ships an MSI, and the choice is not cosmetic. The NSIS installer shipped
 * first was an unsigned unknown binary performing its own writes, and on a machine
 * with security software in the filesystem stack those writes were silently dropped:
 * the program folder was never created, and the wizard still ended on "completed
 * successfully" having installed nothing. An MSI performs no writes of its own — the
 * files, the shortcuts and the registry entries are all placed by msiexec.exe, which
 * Microsoft signs, and a failed step rolls the transaction back instead of reporting
 * success. The same machine that installed nothing from NSIS installs the MSI.
 *
 * `embedBootstrapper` is part of the same argument: the downloadBootstrapper default
 * compiles a deferred custom action that runs hidden PowerShell to fetch and execute
 * an EXE, which is the most AV-hostile thing a package can carry.
 */
test("Windows ships an MSI rather than an NSIS installer", async () => {
  const bundle = JSON.parse(await read("src-tauri/tauri.conf.json")).bundle;
  expect(bundle.targets).toContain("msi");
  expect(bundle.targets).not.toContain("nsis");
  expect(bundle.windows.webviewInstallMode.type).toBe("embedBootstrapper");
});

/**
 * The updater trusts exactly one key. A release signed by anything else is refused,
 * which is the only reason it is safe to let an app replace itself from the internet —
 * so the three halves have to stay together: artifacts to serve, a key to check them
 * against, and a workflow that signs with the matching private half.
 *
 * The endpoint is pinned to `releases/latest/download` rather than a tag, because the
 * app asks the same URL forever and the release is what moves.
 */
/**
 * The dashboard is a remote page — the sidecar serves it over loopback — and a remote
 * page reaches no Tauri API at all unless a capability names its origin. The update
 * notice needs exactly one channel through, so this pins how far that opening goes: the
 * loopback origins the shell itself started, the event permission the notice listens on,
 * and nothing that would let a page reach the sidecar, the tray or autostart.
 */
test("the page is granted the update channel and nothing else", async () => {
  const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
  expect(config.app.withGlobalTauri).toBe(true);
  expect(config.app.security.capabilities).toEqual(["default", "update-notice"]);

  const capability = JSON.parse(await read("src-tauri/capabilities/update-notice.json"));
  expect(capability.windows).toEqual(["main"]);
  expect(capability.remote.urls).toEqual(["http://localhost:*", "http://127.0.0.1:*"]);
  expect(capability.permissions).toEqual(["core:event:default"]);

  // The three commands behind it are the app's own, and every one is about an update.
  const shell = await read("src-tauri/src/lib.rs");
  expect(shell).toContain("tauri::generate_handler![pending_update, install_update, open_release_page]");
});

/**
 * `restart` does not run the `RunEvent::Exit` handler that kills the sidecar, and a
 * server that outlives the update keeps port 4747. The next launch then falls back to
 * an ephemeral port while the widget, the wezterm strip and the CLI keep reading the
 * version the update replaced — stale numbers, presented as current.
 */
test("the update kills the server it is replacing before restarting", async () => {
  const shell = await read("src-tauri/src/lib.rs");
  const install = shell.slice(shell.indexOf("async fn install_update"), shell.indexOf("fn open_release_page"));

  expect(install).toContain("child.kill()");
  expect(install.indexOf("child.kill()")).toBeLessThan(install.indexOf("app.restart()"));
});

test("the updater has artifacts, a public key and somewhere to look", async () => {
  const config = JSON.parse(await read("src-tauri/tauri.conf.json"));

  expect(config.bundle.createUpdaterArtifacts).toBe(true);
  expect(config.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/);
  expect(config.plugins.updater.endpoints).toEqual([
    "https://github.com/SandroHub013/llm-quota/releases/latest/download/latest.json",
  ]);

  const workflow = await read(".github/workflows/release.yml");
  expect(workflow).toContain("TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}");
  expect(workflow).toContain("uploadUpdaterJson: true");
});

/**
 * The splash screen is bundled into the desktop binary and shown before any server
 * exists. The dashboard's zero-third-party-request promise covers it too — and here it
 * is not even reachable over the network to be caught later.
 */
test("the splash screen loads nothing remote", async () => {
  const splash = await read("src-tauri/splash/index.html");
  // The allowance is compared against the host alone, not against a prefix of the
  // whole URL: `www.w3.org.example.com` and `www.w3.org.evil/` both start with the
  // allowed string while belonging to somebody else, and a guard that can be walked
  // past by appending characters is not a guard.
  const remote = [...splash.matchAll(/\bhttps?:\/\/([^\s"'`)]+)/g)]
    .map((match) => match[1]!.split("/")[0]!.toLowerCase())
    .filter((host) => host !== "www.w3.org");
  expect(remote).toEqual([]);
});
