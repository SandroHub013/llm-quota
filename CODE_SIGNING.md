# Code signing policy

> **Status: applied for, not yet granted.** Until the certificate is issued, released binaries are
> unsigned and Windows SmartScreen will report an unknown publisher. The
> [portable build](README.md#desktop-app) exists for exactly this reason. This page describes the
> policy that applies once signing is in place.

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

## Project

**LLM Quota** — one live dashboard for every AI subscription you pay for. It reads quota and local
token spend from AI coding CLIs already installed on the machine, and shows every upcoming rate
limit reset on one time axis. It ships as a desktop application for Windows, macOS and Linux, a
command line tool, and a Windows desktop widget.

- Source: https://github.com/SandroHub013/llm-quota
- Licence: [MIT](LICENSE)
- Downloads: https://github.com/SandroHub013/llm-quota/releases

## Team roles

This is a single-maintainer project. All three roles are held by the same person, who is the sole
author and the owner of the repository.

| Role | Member |
|---|---|
| Author — may modify source without further review | Alessandro Boni ([@SandroHub013](https://github.com/SandroHub013)) |
| Reviewer — reviews changes from non-committers | Alessandro Boni ([@SandroHub013](https://github.com/SandroHub013)) |
| Approver — approves each signing request | Alessandro Boni ([@SandroHub013](https://github.com/SandroHub013)) |

Contributions arrive as pull requests from forks and are reviewed before merge, as
[CONTRIBUTING.md](CONTRIBUTING.md) describes. The default branch is protected: no direct pushes, no
force pushes, and the full test suite must pass before a merge. Multi-factor authentication is
required for repository and signing access.

## Build and release process

Signed artifacts are produced only by the automated release workflow, from the tagged source in
this repository. Nothing is built or signed on a maintainer's machine.

- Workflow: [`.github/workflows/release.yml`](.github/workflows/release.yml)
- Trigger: pushing a `v*` tag
- The desktop application is built with [Tauri](https://tauri.app); the server it embeds is compiled
  from this repository's TypeScript by `bun build --compile`.
- Every action used by the workflow is pinned to a commit SHA rather than a mutable tag.
- The test suite, the type checker and the linter all run before any artifact is built.

## Privacy

**This program will not transfer any information to other networked systems unless specifically
requested by the user.**

This is not a courtesy statement — it is the point of the project, and it is enforced by tests:

- No telemetry, no analytics, no crash reporting. There is no server to report to.
- The dashboard makes zero third-party requests. Fonts and provider logos are served from the
  application itself; [a test](src/frontend.test.ts) fails the build if any external host appears.
- The server binds to loopback only, and refuses requests whose `Host` header is not a loopback
  name, which closes DNS rebinding from a page in the user's browser.
- Network requests are made only to the AI providers the user holds a subscription with, to read
  that user's own quota, and only through each provider's documented interface.
- OAuth credential files belonging to other tools are never read or modified.

Full detail: [Privacy](README.md#privacy) and [SECURITY.md](SECURITY.md).
