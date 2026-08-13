# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The Linux window drew nothing until the pointer moved over it**, and what appeared then was torn.
  Nothing was wrong with the page: WebKitGTK's DMA-BUF renderer never hands over what it drew on a
  large share of desktops — GNOME under Wayland and NVIDIA's driver especially — so only the regions
  an input event invalidated ever reached the screen. The shell now turns that renderer off on Linux
  before the webview starts, and leaves it alone if the environment already sets it. The cost is a
  slower compositing path on a window that refreshes every few seconds; a window that draws
  correctly and slowly beats one that draws quickly and wrong.
- **The widget used fonts only Windows has.** Eleven call sites named `Cascadia Mono` and `Segoe UI`
  directly, and Tk substitutes silently rather than raising — so on Linux and macOS it drew in
  whatever the desktop picked. The provider rows are laid out in character widths, a measurement
  that only means something in a monospaced face, so a proportional substitute put the numbers out
  of line with their labels. Families are now chosen at startup from what is installed, Windows
  names first so that machine is unchanged.
- **The dashboard's Widget button did nothing on Linux and macOS.** The Linux desktop entry carried
  `NoDisplay=true`, which hides it from the chooser the browser opens, and registration reported a
  success it never verified. macOS registered nothing at all; it now builds a small AppleScript
  launcher bundle, because a URL there arrives as an Apple Event rather than as arguments and
  anything simpler loses the server the dashboard named.

## [0.5.0] — 2026-08-13

### Added

- **The widget runs on macOS and Linux.** It was Windows-only for a reason that had nothing to do
  with Tk: `winreg` and `ctypes.wintypes` were imported at module scope, so the file could not even
  be read anywhere else. Those imports are now taken only where they exist, and each thing they were
  used for has a local answer — the single-instance mutex becomes the wake port, which two processes
  cannot bind at once; notifications go through `osascript` on macOS and `notify-send` on Linux;
  `llmquota://` is registered through a desktop entry on Linux. macOS registers URL schemes for
  application bundles rather than scripts, so there `--register-protocol` prints the command to run
  instead of pretending. Acrylic blur, the clipped outline and the transparent colour key stay
  Windows-only, because X11 and Quartz have no equivalent: the window is a plain rectangle
  elsewhere, showing the same numbers. Its tests now run on all three platforms in CI, which is what
  keeps the claim true.

- **The app tells you when a release is out, and can install it.** A quota monitor is left running
  for weeks, so it cannot rely on being relaunched to notice. Each launch asks once and stays quiet
  unless there is something newer; the tray carries **Check for updates…** for asking on purpose,
  which answers either way. On Windows and macOS, agreeing downloads the update, installs it and
  restarts the app — nothing is downloaded before the answer. The Linux build opens the release
  page instead: it was installed from a deb by a package manager that owns those files, and the
  updater replaces AppImages, which this project does not ship.
- Updates are signed. The app carries the public half of a key and refuses a release the matching
  private half did not sign, which is what makes replacing itself from the internet safe to offer.
  The update check is the only request this app makes to anything but loopback, and it goes through
  the operating system's own TLS rather than a bundled certificate store — a machine behind a proxy
  has already told its OS what to trust.

## [0.4.0] — 2026-08-13

### Added

- **A desktop app for Windows, macOS and Linux.** Installing used to mean installing Bun, cloning
  the repository and keeping a terminal open — a bar that excludes everyone who pays for four AI
  subscriptions without living in a shell. The bundle carries the server compiled by
  `bun build --compile`, so there is nothing else to install. It has its own window, a tray icon,
  close-to-tray, and start-at-login. The shell is [Tauri](https://tauri.app) and holds no product
  logic: it starts the same loopback server a source install runs, waits for it to answer, and
  points the window at it. It takes port 4747 when free and any free port otherwise, so it never
  collides with a `bun start` already running.
- **Windows installs from an MSI**, not an NSIS `setup.exe`. An unsigned installer that performs
  its own writes can have them dropped by security software in the filesystem stack, and nothing
  reports it: on the machine this was found on, the NSIS installer created no program folder, wrote
  no registry entry and no shortcut, and still exited zero on "completed successfully". Reproduced
  across four install paths. An MSI writes nothing itself — msiexec, which Microsoft signs, places
  every file, shortcut and registry key, and rolls the transaction back rather than reporting a
  success it did not achieve. The same machine installs it to `C:\Program Files\LLM Quota` with a
  Start Menu entry, an Add/Remove Programs entry and a byte-exact sidecar. The cost is the
  administrator prompt a per-machine install has to earn. This is a sturdier install path, not a
  way around antivirus: only a signature answers a scanner that objects to the download itself.
- `webviewInstallMode` is now `embedBootstrapper`. The default compiles an installer step that
  runs hidden PowerShell to download and execute an EXE — 1.8 MB saved is not the point.
- **Linux ships the `.deb` only.** The AppImage was announced and never built: its bundler
  resolves the shared libraries of every file it packages, `ldd` exits non-zero on the compiled
  server, and linuxdeploy aborts on that rather than skipping the file. Anything that cannot
  install a deb has the standalone server executable, which every release already carries.
- **A portable Windows build**, `llm-quota-portable-windows-x64.zip`: unzip and run, no installer
  and no administrator prompt, for an account that cannot answer one.
- **A standalone server executable** on every release, for anyone who wants the dashboard without
  the window: one file, no Bun, no clone.
- The desktop window opens at the viewport the dashboard is laid out for, sized in logical pixels
  and clamped to the screen. The height is deliberately under the 850 that turns the token ledger
  into a full-width band: a browser loses roughly that much to its tab strip and address bar, so
  matching it keeps the ledger the fourth card users already know rather than moving it below the
  providers on a window that has no chrome.
- **A release workflow.** Pushing a `v*` tag builds the installers on all four targets and attaches
  them to a draft release. The three releases before this one were assembled by hand.
- The project mark is stamped on everything Windows shows a user: the application executable, the
  server executable — which otherwise ships wearing Bun's mascot and no publisher — and the
  installer, whose icon, header strip and welcome sidebar were NSIS's own defaults. The server
  binary also carries the publisher, description, version and copyright that fill the properties
  dialog and the SmartScreen prompt.
- CI now compiles the desktop shell and runs Clippy with warnings as errors, so a change to the
  server that breaks the shell fails a pull request instead of a release.

### Changed

- The server no longer reads `public/` from disk. Inside a compiled binary that directory does not
  exist — `import.meta.url` resolves into Bun's virtual filesystem — so the dashboard would have
  served 404s in the desktop build and nowhere else. Assets are now embedded through a generated
  manifest, and the static route resolves a key rather than a path, which retires the traversal
  guard it needed: a name that was never shipped simply is not in the map.

## [0.3.0] — 2026-08-08

### Added

- **The official status-line bridge now installs on macOS and Linux.** It was a Windows prototype
  that threw `official_bridge_windows_prototype` everywhere else, which left those platforms with
  one live card out of three. The POSIX bridge is a small JavaScript module Bun runs, rather than
  shell: reading the JSON the host pipes in needs a JSON parser, and neither `jq` nor `python3` can
  be assumed present on a fresh machine. The interpreter is the absolute Bun resolved at install
  time, because a status line inherits whatever environment the editor was launched from and that
  routinely lacks `~/.bun/bin` on `PATH`.
- **The CLI is published on npm**: `bun add -g llm-quota`, or `npm install -g llm-quota`. It still
  runs on Bun — npm is only the delivery channel.
- pi, Prime Agent and NikCLI histories are read into the local token ledger.
- This changelog.

### Changed

- The generated bridge script stays a readable file on disk in both spellings. A tool that writes
  itself into another client's settings has to let the user read exactly what it wrote.
- Uninstalling restores the status line captured at install time and removes every file the bridge
  created, on both platforms.

### Removed

- **The Vercel adapter**, which contradicted the local-first design.
- **The OpenCode Zen gateway**, its card scaffolding and its mark. The public endpoint returns a
  model catalog, not numeric usage, limits or reset times. OpenCode remains a local ledger source.

### Fixed

- **The CLI accepted arguments it should have rejected.** Unknown flags, a repeated `--json`, and
  wrong operand counts were all ignored silently; `doctor` and `stats` accepted a `--json` they
  never honoured. Operand parsing also dropped every `-`-prefixed token, so an id beginning with a
  dash was swallowed instead of read.
- **`llm-quota stats` could hang indefinitely.** The npm and GitHub lookups had no timeout; both now
  abort after 10 seconds.
- **A crash during a config write could truncate the credential file.** Writes go to a temporary
  file in the same directory and are renamed into place, so a crash leaves either the old JSON or
  the new one. The `0600` mode is now reapplied after the rename — `mode` is ignored when the
  destination already exists — and the directory is forced to `0700` on every write.
- **Concurrent tabs and widget requests could interleave read-modify-write cycles** on the config.
  They are serialized behind a write queue.
- Non-string values in the config `keys` map are dropped on read instead of reaching provider
  requests.
- The usage view filter reaches every ledger source, so the shared figure agrees across the dialog,
  the button and the widget.

### Security

- Provider marks and preview images are served locally; the last remotely loaded branding assets are
  gone. The frontend continues to make zero third-party requests, enforced by a test.

## [0.2.0] — 2026-08-04

Three provider cards ship in this release: **Claude Code**, **Codex (ChatGPT)** and **Gemini /
Antigravity**. Z.ai joins Kimi as a disabled card — neither publishes a quota field a third-party
dashboard may read, and a card promising data that never arrives is worse than no card.

### Fixed

- **The spend total could silently read €0.00.** The ledger read every history file inside one try
  block. Claude Code and Codex rotate and delete their own session files while the dashboard polls
  every five seconds, so a file listed by the walk could vanish before it was read — discarding
  every row already collected. Files are read independently now, and the parse caches forget files
  a scan no longer sees.
- **One malformed config broke every card at once.** A `~/.llm-quota/config.json` without a `keys`
  field failed every provider simultaneously. The field is always present now.
- The bridge command is written with forward slashes: Claude Code hands the status-line command to a
  shell, which ate the backslashes and left the status line blank. The recursion guard normalises
  separators too, so a bridge is never captured as the user's previous command and chained into
  itself.
- The shared wrapper follows who is actually installed. Enabling one provider no longer starts
  capturing a sibling's quota, and removing one stops the wrapper rewriting the cache the teardown
  just deleted.
- Countdowns follow their own metric instead of matching by DOM position.
- Codex windows are named after the duration Codex reported.
- `llm-quota provider --json codex` no longer reads the flag as the provider id.

### Security

- **The local API is pinned to loopback.** Requests require a loopback `Host`, and writes carrying a
  foreign `Origin` are refused before reaching a handler. This closes DNS rebinding against
  `/api/quota` and `/api/usage`, and CSRF against `POST /api/official-bridge/:id` and
  `POST /api/key/:id`, both of which were simple requests browsers sent cross-origin with no
  preflight.
- `~/.llm-quota/config.json` is written `0600`.

### Added

- Currency, filters and sorting in the local token cost table. Both currencies come from the API.
- Gemini's third-party quota pool is named instead of showing `3p`.
- A doc-sync test asserts the frontend lineup, skeleton cards, landing-page demo and issue template
  against the provider registry.
- CI runs the widget's Python tests on Windows, where its module can load.

## [0.1.0] — 2026-08-03

Initial release: local-first live quota dashboard, CLI, and Windows widget.

[0.5.0]: https://github.com/SandroHub013/llm-quota/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/SandroHub013/llm-quota/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/SandroHub013/llm-quota/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SandroHub013/llm-quota/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SandroHub013/llm-quota/releases/tag/v0.1.0
