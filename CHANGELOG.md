# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **Non-GET `/api/*` endpoints now require an inter-process token.** The Origin guard stops
  cross-origin browser writes, but a non-browser local process simply omits `Origin` and could
  call `POST /api/key/:id` or `POST /api/official-bridge/:id` — the latter rewrites another
  client's settings file. The server now shares a random token through a 0600 file next to the
  credentials (persisted across restarts, so the CLI and the widget never re-pair), injects it
  into the served page as a meta tag, and compares it with `timingSafeEqual`. GETs stay open:
  they expose quota data the local user already owns, and the widget polls them without a
  pairing step.
- Internal error details (absolute paths, provider-response fragments) no longer reach API
  clients; they stay in the server log and the client gets a generic message.
- The served dashboard now carries a `Content-Security-Policy` (`default-src 'self'`, inline
  styles only) and `X-Content-Type-Options: nosniff`.

### Changed

- `src/usage.ts` (1016 lines) is split into cohesive modules under `src/usage/` — one parser per
  source, pricing, caching, collection — with the public API unchanged behind a re-export
  barrel. The seven per-source try/catch blocks in `collectUsage` are now a descriptor array.
- `writeJsonAtomic` lives in a single shared module; the bridge's direct-write fallback for
  locked destinations is an explicit, documented option.
- Every silently swallowed exception in the Windows widget is now logged to a rotating
  `widget_debug.log` (WARNING by default, routine fetch failures at DEBUG). UI degradation is
  unchanged.
- `package.json` gains a `test` script.

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

[0.3.0]: https://github.com/SandroHub013/llm-quota/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SandroHub013/llm-quota/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/SandroHub013/llm-quota/releases/tag/v0.1.0
