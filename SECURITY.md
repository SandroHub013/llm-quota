# Security Policy

## Supported versions

LLM Quota ships from `main` and fixes land in the next release. Only the latest
minor line receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.3.x   | ✅ Yes |
| 0.2.x   | ❌ No — upgrade to 0.3.x |
| < 0.2   | ❌ No |

## Reporting a vulnerability

Report privately through GitHub's
[**Report a vulnerability**](https://github.com/SandroHub013/llm-quota/security/advisories/new)
form, which opens a draft advisory visible only to the maintainers.

Please do not open a public issue for a security problem.

What helps most:

- the version, operating system, and Bun version;
- what an attacker gains, not only what misbehaves;
- the smallest sequence that reproduces it.

You can expect an acknowledgement within **7 days** and an assessment within
**14 days**. A confirmed issue is fixed and released before the advisory is
published, and you are credited unless you would rather not be.

## What is in scope

This is a local-first tool: the server binds to `127.0.0.1`, and provider
credentials, session transcripts, and spend history never leave the machine.
The interesting boundaries are therefore local ones.

In scope:

- **Anything that gets a web page to reach the local API.** The server pins the
  `Host` header against a loopback allowlist to stop DNS rebinding, and refuses
  cross-origin writes by `Origin`. A bypass of either is a vulnerability, because
  `/api/quota` and `/api/usage` carry the plan and the local spend history.
- **Path traversal out of `public/`** through the static-file route.
- **Credential handling.** `~/.llm-quota/config.json` is written atomically at
  mode `0600`. A key reaching a log, a process argument, an error message, or the
  `/api/quota` payload is a vulnerability.
- **The official status-line bridge.** It writes a script and rewrites another
  client's settings file on explicit opt-in. Anything that makes it write outside
  `~/.llm-quota/official`, run an attacker-controlled command, or fail to restore
  the original status line on removal is in scope.
- **Local history parsing.** The scanners read files written by other tools; a
  crafted session file that escapes the parser is in scope.

Out of scope:

- Exposing the server to a network yourself (`PORT` on a public interface, a
  reverse proxy, a tunnel). It is designed for loopback and has no
  authentication by design.
- Vulnerabilities in the provider CLIs, or in their local files, rather than in
  how this project reads them.
- Findings that require an attacker who already has your user account, which can
  read `~/.llm-quota/config.json` directly regardless of this project.
- Missing hardening headers on a loopback dashboard with no authentication and no
  cross-origin write path.

## Automated checks

Every push and pull request to `main` runs CodeQL (`security-and-quality`) over
the TypeScript and Python sources. Dependabot proposes dependency updates weekly
for npm, pip, and GitHub Actions.
