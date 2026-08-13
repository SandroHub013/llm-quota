<div align="center">

# LLM Quota

**One live dashboard for every AI subscription you pay for.**

Claude Code · Codex · Gemini — quotas, reset times, and local token spend.
Runs on your machine. Talks to nobody but the providers.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/SandroHub013/llm-quota/actions/workflows/ci.yml/badge.svg)](https://github.com/SandroHub013/llm-quota/actions/workflows/ci.yml)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-000?logo=bun)](https://bun.sh)
[![GitHub Release Downloads](https://img.shields.io/github/downloads/SandroHub013/llm-quota/total?color=green&logo=github)](https://github.com/SandroHub013/llm-quota/releases)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Stars](https://img.shields.io/github/stars/SandroHub013/llm-quota?style=social)](https://github.com/SandroHub013/llm-quota/stargazers)

**[→ llm-quota website](https://sandrohub013.github.io/llm-quota/)**

[Quickstart](#quickstart) · [Personalization](#your-installation-your-data) · [Providers](#supported-providers) · [CLI](#cli-for-terminals-and-ai-agents) · [Privacy](#privacy) · [Contributing](CONTRIBUTING.md) · [🇮🇹 Italian](README.it.md)

![LLM Quota dashboard](docs/dashboard-preview.jpg)

</div>

---

## The problem

You pay for four or five AI subscriptions. Each one rate-limits you differently, in a different
console, on a different clock. Claude Code has a 5-hour window *and* a weekly cap. Codex has its
own. Gemini counts per model. The moment you actually hit a limit, the only question that matters
is the one no percentage bar answers:

> **When am I back?**

LLM Quota puts every reset from every provider on one horizon — now → 7 days — so you can see at a
glance which subscription is free, which is cooling down, and exactly when to come back.

## Features

- ⏳ **Reset horizon** — every currently measurable provider reset on one time axis. Hover a marker, its card
  lights up; hover a card, its marker lights up.
- ⚡ **Live without reloads** — quotas refresh silently every minute, local spend every five seconds,
  and reset countdowns keep moving between requests. Unchanged data does not repaint the interface.
- 🔑 **Official-surface first** — Codex is queried through `codex app-server`; Claude Code and
  Antigravity deliberately deliver quota JSON through opt-in local status-line bridges. LLM Quota
  never reads or refreshes another client's OAuth token.
- 💶 **Local token ledger** — totals Codex, Claude Code, OpenCode, Kimi Code, pi, Prime Agent
  and NikCLI history by
  model, effort and main/subagent, with an estimated API-equivalent value in euros and a
  context-reuse efficiency index. A GitHub-style daily calendar shows when those tokens and euros
  were spent; its optional GitHub view always uses the locally authenticated `gh` account.
- 🔒 **Local-first** — no cloud, no database, no account. Keys and tokens never leave the machine.
- 🚫 **Zero third-party requests** — fonts and provider logos ship in `public/`. The page loads
  nothing from a CDN, a font host, or a favicon service. [Enforced by a test.](src/frontend.test.ts)
- 🤖 **CLI built for AI agents** — `llm-quota status --json` gives sanitized JSON and meaningful
  exit codes, so an agent can check its own budget before starting a long job.
- 🖥️ **Desktop app** — an installer for Windows, macOS and Linux with the server compiled inside it.
  No Bun, no clone, no terminal. Its own window, a tray icon, close-to-tray, and start at login.
- 🪟 **Desktop widget, on all three** — a floating always-on-top Tk widget, launched from the
  dashboard via the `llmquota://widget` protocol on Windows and Linux, and by running it directly on
  macOS. It silently refreshes quotas every minute, local spend every five seconds, and keeps reset
  countdowns moving between requests. It shows the same provider cards as the dashboard; OpenCode
  remains included only in local spend. Windows adds acrylic blur and a clipped outline the other
  two have no equivalent for; the numbers are the same everywhere.
- ♿ **Accessible** — full keyboard navigation, `prefers-reduced-motion` respected, all primary
  providers on screen without scrolling from 1280×800 up.

---

## Quickstart

### Desktop app — nothing to install first

Download the installer for your platform from
**[the latest release](https://github.com/SandroHub013/llm-quota/releases/latest)** and open it. No
Bun, no clone, no terminal: the server ships inside the app. Windows asks for the administrator
prompt every MSI asks for, and installs to `C:\Program Files\LLM Quota`.

| Platform | File |
|---|---|
| Windows 10/11 | `LLM.Quota_<version>_x64_en-US.msi` |
| macOS (Apple silicon) | `LLM.Quota_<version>_aarch64.dmg` |
| macOS (Intel) | `LLM.Quota_<version>_x64.dmg` |
| Linux | `LLM.Quota_<version>_amd64.deb` |

It lives in the tray: closing the window leaves it running, **Start at login** is one click, and
**Quit** is the only thing that stops the server. It also tells you when a release is out —
on Windows and macOS it can install one and restart itself; the Linux build points at the
download instead, because the package manager owns the files it installed.

> **The download is unsigned.** Code signing certificates are a recurring cost this project does
> not carry, so the first launch is challenged: on Windows, SmartScreen says *unknown publisher* —
> **More info → Run anyway**; on macOS, Gatekeeper refuses a double click — right-click the app and
> choose **Open**. Both are one-time. Build from source below if you would rather not.

### From source

**[Download the desktop app](https://github.com/SandroHub013/llm-quota/releases/latest)** — Windows,
macOS and Linux. Nothing else to install: the server ships inside it. It opens in its own window,
keeps a tray icon, and can start at login.

Or run it from source. That needs [Bun](https://bun.sh) 1.0+ (the server uses `Bun.serve`; Node is
not supported), and Python 3 only for the desktop widget:

```bash
git clone https://github.com/SandroHub013/llm-quota.git
cd llm-quota
bun install
bun start          # → http://localhost:4747
```

That is the whole setup. Codex populates through its official app-server. The Claude and Gemini
cards each offer **Enable official bridge** once, so their official clients publish quota to LLM
Quota — on Windows, macOS and Linux alike. One click installs it, one click removes it, and your
existing status line is preserved either way.

<details>
<summary>Standalone server — one executable, no Bun</summary>

Every release also carries the bare server, for a machine that should run the dashboard without
the desktop shell — a homelab box, a second monitor, a VM:

```bash
chmod +x llm-quota-server-linux-x64      # macOS: llm-quota-server-macos-arm64
PORT=4747 ./llm-quota-server-linux-x64
```

It is the same binary the desktop app embeds: the frontend, the fonts and the provider logos are
compiled into it, so it needs no files beside it.
</details>

<details>
<summary>One-liner install</summary>

macOS / Linux:
```bash
git clone https://github.com/SandroHub013/llm-quota.git && cd llm-quota && bun install && bun start
```

Windows (PowerShell):
```powershell
git clone https://github.com/SandroHub013/llm-quota.git; cd llm-quota; bun install; bun start
```
</details>

<details>
<summary>Install the CLI globally</summary>

```bash
bun add -g llm-quota      # or: npm install -g llm-quota
llm-quota status
```
Both `llm-quota` and `webquota` are registered as commands. The package still runs on Bun — npm is
only the delivery channel. To track the branch instead of a release, use
`bun add -g github:SandroHub013/llm-quota`.
</details>

<details>
<summary>Other options</summary>

```bash
bun run dev            # hot reload
PORT=8080 bun start    # custom port on macOS / Linux
```

```powershell
$env:PORT=8080; bun start    # custom port on Windows
```
</details>

---

## Your installation, your data

No runtime account, username, quota, or spend total is tied to the project author:

- Codex authentication remains inside `codex app-server`; LLM Quota never opens Codex's auth file.
- Opt-in Claude/Antigravity bridges cache only quota windows and reset times. They exclude account
  identity, transcripts and access tokens, and preserve an existing custom status line.
- The token ledger scans the current user's local Codex, Claude Code, OpenCode, Kimi Code, pi,
  Prime Agent and NikCLI history. Hermes keeps no local token record, so its spend cannot be counted.
- The optional contribution calendar queries the viewer authenticated by the official GitHub CLI.
  Run `gh auth login` to enable it; without `gh`, the local spend calendar continues to work.
- A dashboard running on a custom local port passes its own origin to the widget automatically.
  The CLI and a manually launched widget also accept `LLM_QUOTA_URL`; the widget additionally accepts
  `--server-url`.

Screenshots and social previews use synthetic sample data. They contain no maintainer account,
credentials, or real usage history.

---

## Supported providers

| Provider | Supported source | What you get |
|---|---|---|
| **Claude Code** | Official status-line JSON (opt-in) | 5h + weekly quota %, reset time and source freshness |
| **Codex** (ChatGPT) | Official `codex app-server` JSON-RPC | Active plan + usage windows |
| **Gemini / Antigravity** | Official Antigravity status-line JSON (opt-in) | Per-bucket remaining quota and reset time |
| **z.ai** | Card disabled | The GLM Coding Plan status line carries no quota field to read; token spend still appears in the local ledger |
| **Kimi / Moonshot** | Card disabled | Kimi Code plan quota has no compliant machine-readable source; token spend still appears in the local ledger |

Three provider cards ship today. OpenCode, pi, Prime Agent and NikCLI are ledger-only sources: they
publish no plan quota, so they contribute local spend and no card. OpenCode's Zen
gateway was dropped entirely, because the public endpoint exposes a model catalog rather than
numeric usage, limits or reset times. Kimi is disabled for the same reason: its official status line
carries no quota, rate limit or subscription field, the plan windows behind `/usage` are reachable
only with the Kimi Code CLI's own OAuth token, and the documented Open Platform balance is API credit
rather than plan quota. Z.ai's own plugin publishes no quota field either, so its card was withdrawn
rather than left showing an empty promise.

Keys you paste yourself are stored locally in `~/.llm-quota/config.json`. They are never sent
anywhere except to the provider they belong to, and never committed.

**Want another provider?** Add an adapter in `src/providers/` implementing the `Provider`
interface and register it in `src/providers/index.ts`. That is the whole contract — see
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## CLI for terminals and AI agents

With the server running:

```bash
bun run cli status            # compact text summary
bun run cli status --json     # sanitized JSON, safe to paste into a prompt
bun run cli provider codex    # one provider only
bun run cli doctor            # health check
bun run cli stats             # public download counters for the project
```

Exit codes make it scriptable — and let an agent decide for itself whether to start a job:

| Code | Meaning |
|---|---|
| `0` | Healthy, quota available |
| `1` | Warning — at least one quota ≤ 20% |
| `2` | Auth error or provider unreachable |
| `3` | Server offline or bad arguments |

Point it at another host or port with `LLM_QUOTA_URL=http://localhost:8080`.

---

## Desktop app

[Every release](https://github.com/SandroHub013/llm-quota/releases/latest) ships an installer for
Windows (`.msi`), macOS (`.dmg`, Apple silicon and Intel) and Linux (`.deb`). There is
no Bun to install and no repository to clone — the compiled server is inside the bundle.

- Its own window, so the dashboard is not a browser tab you lose.
- A tray icon. Closing the window hides it; the server keeps running and **Quit** stops both.
- **Start at login**, from the tray menu.
- It notices releases. The tray has **Check for updates…**, and a launch that finds a newer
  version says so once. On Windows and macOS it installs the update and restarts; on Linux it
  opens the release, because the deb was installed by a package manager that owns those files.
  Every update is checked against a signing key compiled into the app, so a release this project
  did not sign is refused.
- It takes port `4747` when free and any free port otherwise, so it never fights a `bun start` you
  already have open. The widget follows whichever origin the dashboard reports.

The shell is [Tauri](https://tauri.app): it uses the operating system's own webview instead of
shipping a browser, which is why the download is ~30 MB rather than ~150 MB. It holds no product
logic — the dashboard, the API and every provider adapter are the same code the source install runs.

> **The installers are unsigned.** Windows SmartScreen will say "unknown publisher" — *More info →
> Run anyway*. macOS Gatekeeper will refuse a double click — right-click the app → *Open*.
>
> Windows gets an MSI for a related reason. An unsigned installer that performs its own writes
> can have them dropped by security software sitting in the filesystem stack, with no error
> anywhere: the NSIS build this project shipped first ended on "completed successfully" having
> installed nothing. An MSI writes nothing itself — every file, shortcut and registry key is
> placed by `msiexec.exe`, which Microsoft signs, and a failed step rolls back rather than
> reporting success. That is a stronger install path, not a way around antivirus: a scanner that
> objects to the contents of a download still objects. Only a signature answers that.
>
> A free open-source signing certificate is being applied for — see the
> [code signing policy](CODE_SIGNING.md). Until it lands: the source and the build workflow are both
> public, so you can rebuild any release yourself and compare.

<details>
<summary>Portable, no installer and no administrator prompt (Windows)</summary>

`llm-quota-portable-windows-x64.zip` on every release, for a machine where you cannot elevate.
Unzip it anywhere and run
`llm-quota-desktop.exe` — the server sits beside it and is started for you. Nothing is written
outside the folder you chose except the usual per-user config in `~/.llm-quota/`.

Linux has no equivalent yet. The AppImage bundler resolves the shared libraries of everything
it packages, and the compiled server is a binary `ldd` refuses, which aborts the build rather
than skipping the file — so releases carry the `.deb` and, for anything that cannot install one,
the standalone server below.
</details>

<details>
<summary>Just the server, no window</summary>

The same release attaches `llm-quota-server-<platform>`: one executable, no Bun, no clone. It serves
the dashboard at `http://localhost:4747` and nothing else changes.

```bash
chmod +x llm-quota-server-linux-x64
PORT=4747 ./llm-quota-server-linux-x64
```
</details>

<details>
<summary>Build it yourself</summary>

Needs the [Rust toolchain](https://rustup.rs) on top of Bun, plus
[Tauri's system dependencies](https://tauri.app/start/prerequisites/) on Linux.

```bash
bun run desktop         # dev: compiles the sidecar, opens the app with hot reload
bun run desktop:build   # installers in src-tauri/target/release/bundle/
```

`bun run sidecar` produces the bare server executable on its own, in
`src-tauri/binaries/`. It is the same file the release publishes and the bundle embeds — there is
deliberately no second build path, so the published binary can never be the one that missed the
icon and version metadata.
</details>

---

## Desktop widget

```bash
python widget.py --register-protocol
```

Registers `llmquota://widget`, so the **Widget** button in the dashboard launches the widget and
passes the dashboard's local origin automatically. Windows keeps that registration in the registry
and Linux in `~/.local/share/applications`.

**macOS registers URL schemes for application bundles, not for scripts**, so the dashboard button
cannot start it there. `--register-protocol` prints the command to run instead, and the widget
itself works the same once started.

For a manual or remote setup, on any platform:

```bash
python widget.py --server-url http://localhost:8080
python widget.py --register-protocol --server-url http://localhost:8080
```

Tk is part of the Python standard library but is packaged separately on Debian and Ubuntu:
`sudo apt install python3-tk`.

---

## Privacy

This is the point of the project, so it is worth being precise:

- No telemetry, no analytics, no crash reporting. There is no server to report *to*.
- The frontend makes **zero** third-party requests. Fonts (Syne, Schibsted Grotesk, JetBrains
  Mono — ~102 KB, latin subset) and provider logos are served from `public/`.
  A [test](src/frontend.test.ts) fails the build if any external host creeps back in.
- Provider logos are frozen in the repo deliberately: loading them from the provider — or from a
  favicon service, as an earlier version did — would tell a third party which AI subscriptions
  you hold, on every page load.
- OAuth credential files belonging to Codex, Claude, Gemini, OpenCode, Kimi, pi, Prime Agent and
  NikCLI are not read or modified. Only their session transcripts and local databases are scanned. User-supplied Open Platform keys are used only with their documented provider API.

---

## Architecture

```text
src/
├── server.ts          # loopback-only Hono backend (/api/quota, /api/key, /api/official-bridge)
├── codex-app-server.ts# official Codex JSON-RPC client
├── official-bridge.ts # opt-in Claude/Antigravity status-line wrappers
├── usage.ts           # local CLI history → token ledger and spend calendar
├── credentials.ts     # user-supplied key config only
├── cli.ts             # CLI for developers and agents
├── cli-core.ts        # quota summary, formatting and exit codes
├── public-mime.ts     # the closed set of extensions the server will serve
└── providers/         # one adapter per provider (fetch → QuotaResult)
public/                # frontend SPA — HTML, CSS, vanilla JS, no build step
├── fonts/             # self-hosted variable fonts (woff2, latin subset)
└── logos/             # official provider marks, frozen
src-tauri/             # desktop shell: window, tray, start-at-login, sidecar lifecycle
scripts/               # asset manifest and sidecar build steps
widget.py              # Tkinter desktop widget (Windows, macOS, Linux)
```

Stack: [Bun](https://bun.sh) + [Hono](https://hono.dev) + TypeScript. One runtime dependency.
No bundler, no framework, no build step for the frontend.

The desktop app adds [Tauri](https://tauri.app) around exactly that, unchanged. `bun build
--compile` turns the server into one executable and Tauri ships it as a sidecar, so the window is
pointed at the same loopback server a source install runs — including its Host allowlist. The
frontend is embedded rather than read from `public/` at runtime: inside a compiled binary that
directory does not exist, so `src/public-assets.generated.ts` maps each served file to an embedded
one. Regenerate it with `bun run generate:assets` after touching `public/`; a test fails if you
forget.

```bash
bun test                        # TypeScript: server, providers, CLI, frontend guards
bun run typecheck
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets   # the desktop shell
python -m unittest widget_test  # Python: the desktop widget
```

---

## Contributing

New provider adapters, bug reports and UI fixes are all welcome — start with
[CONTRIBUTING.md](CONTRIBUTING.md). Good first issues are tagged
[`good first issue`](https://github.com/SandroHub013/llm-quota/labels/good%20first%20issue).

The dashboard, the CLI and the desktop widget are all in English. There is no i18n layer
yet — if you want the UI in another language, that is an open design question worth an
issue before a PR.

## License

[MIT](LICENSE). Free for personal and commercial use.

### Trademarks

The MIT license covers this project's code, not other people's marks. The logos in
`public/logos/` belong to their respective owners (Anthropic, OpenAI, Z.ai, OpenCode, Google,
Moonshot AI) and are included only to identify the service each card refers to. This project is
not affiliated with, endorsed by, or sponsored by any of them.

---

<div align="center">

If this saved you a trip to five different billing consoles, **[⭐ star the repo](https://github.com/SandroHub013/llm-quota)** — it is how other people find it.

</div>
