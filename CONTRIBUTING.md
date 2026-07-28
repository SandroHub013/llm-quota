# Contributing

Issues and PRs welcome. What this file adds to the README is the repo-specific
conventions: what to work on, how contributions are formatted, what has to stay in
sync, and what gets rejected.

## Setup

```bash
git clone https://github.com/SandroHub013/llm-quota.git
cd llm-quota
bun install
bun run dev        # http://localhost:4747, hot reload
```

Before opening a PR:

```bash
bun test
bun run typecheck
```

Both must pass — CI (`.github/workflows/ci.yml`) runs exactly these two commands. A
red CI run is a red PR; fix it before asking for review.

## Where to contribute

Providers change their APIs without warning, so keeping the existing adapters accurate
outranks adding a new one. In priority order:

**Always welcome — the issue is a formality here: title plus evidence, then the PR:**

- **Provider fixes with evidence.** A provider shows wrong numbers, stale resets, or
  its response shape changed. Paste the sanitized output of `bun run cli status
  --json` (read it before posting). For parsing or response-shape fixes, include a real
  response body with credentials scrubbed — the adapter exists to parse that body.
- **New provider adapters.** The most useful addition and a small contract — see
  "Adding a provider" below. Use the `provider` label and the provider-request
  template.
- **Bug fixes with a failing test.** Dashboard, CLI, widget: reproduce it in a test
  first, then make it pass.

**Open an issue first — these are rejected as drive-by PRs:**

- An i18n layer. Strings are hard-coded English by design; see "Localisation".
- New runtime dependencies. The project ships with exactly one (`hono`); adding a
  second is a design decision.
- New surfaces: dashboard pages, widget features, output formats.
- CI, linting, formatting or other tooling changes.

**Not wanted:**

- Telemetry, analytics, error reporting. Ever — local-first is the point of the
  project.
- New translation languages. Keep product strings in English and the existing Italian
  README in sync.
- Changelogs, badges, roadmap files. Git history is the changelog.
- Third-party assets hotlinked into the frontend, in any form.

## Adding a provider

A provider is one file in `src/providers/` that fetches whatever the service exposes
and returns a `QuotaResult`.

1. Read `src/providers/types.ts` for the shape.
2. Copy the closest existing adapter — `zai.ts` is the simplest (API key, one quota
   endpoint), `claude.ts` the most complete (OAuth from disk, caching, rate-limit
   backoff).
3. Register it in `src/providers/index.ts`.
4. If the provider needs a logo, add an official mark to both `public/logos/` and
   `docs/logos/`, then reference it — do **not** hotlink it. `src/frontend.test.ts`
   will fail if you do.
5. Add a test next to the adapter (`*.test.ts`) covering at least the parse of a real
   response body, with any credentials scrubbed.
6. Run the sync checklist below — a provider is listed in more places than the
   registry.

## Ground rules

- **Local-first.** No third-party requests from the frontend: no CDN, no font host,
  no favicon service. `src/frontend.test.ts` enforces it.
- **No telemetry.** Ever.
- **No new runtime dependencies** without a reason in the PR description. Shipping
  with exactly one (`hono`) is a feature.
- **Never commit credentials**, and scrub tokens out of test fixtures. A fixture with
  a real token gets the PR closed, not fixed.
- **Practitioner voice in docs.** Write what broke and what to do, not what one should
  consider doing.

## Formatting

- **Prose wraps at 100 columns** in Markdown. Code blocks, tables and unbreakable
  tokens — URLs, commands — may exceed it; prose may not. Do not break a URL to
  satisfy the count.
- **Headings**: ATX (`##`), sentence case, no trailing punctuation. One `#` per file.
- **Fenced code carries a language** (`ts`, `bash`, `json`) and must be copy-paste
  runnable, not pseudo-code.
- **TypeScript, ESM**, imports with the `.js` suffix, as the rest of `src/` does.
- American English, present tense, imperative mood for rules.

## The sync checklist

Adding, renaming or removing a provider touches more than the adapter:

- [ ] `src/providers/index.ts` — the registry
- [ ] `README.md` and `README.it.md` — tables, taglines, fixed provider counts, and
      asset or trademark lists
- [ ] `package.json` — `description` and `keywords`, if they name providers
- [ ] `docs/index.html` — every provider name or count, including the strip, table, and
      demo data
- [ ] `.github/ISSUE_TEMPLATE/bug_report.yml` — the provider dropdown
- [ ] `public/logos/` and `docs/logos/` — the official mark, self-hosted in the app and site
- [ ] `public/og.jpg`, `docs/og.jpg`, and `docs/dashboard-preview.*` — only if they
      picture the provider list; regenerate rather than hand-editing
- [ ] Repository-wide search — the provider name and fixed counts such as "six
      providers"

The README is the file readers see first and the one that goes stale fastest — check
it even when the change "only" touches code.

## Commits and PRs

- **Conventional Commits**, imperative, lowercase after the colon, as the existing
  history does. Scopes currently in use: `widget`, `site`, `assets`. Use an unscoped
  commit when none fits.
- **One concern per PR.** A provider fix and a landing-page tweak are two PRs.
- **PR title = the commit message** it will be squash-merged as. The body carries: the
  evidence (response body, failing output), the checks run, and before/after output
  for anything user-visible.
- **Every PR closes an issue** (`Closes #N`). No issue, no review: the issue decides
  "should this exist?"; the PR only decides "is this done right?".
- **Labels**: `bug` for wrong numbers and broken behavior, `enhancement` for new
  features, `provider` for adapter work, `documentation` for prose. Maintainers apply
  them; don't open a PR to ask for one.

## Localisation

Keep every user-facing string — dashboard, CLI, widget — in English and hard-coded at
its use site. There is no i18n layer, and adding one is a design decision rather than a
translation task: open an issue first if you want to propose it.

One thing to keep consistent when you touch strings: window labels are named the same
way for every provider (`Session (5h)`, `Weekly (7d)`, `Daily (24h)`), even when the
provider calls them something else. `normaliseLabel` in `src/providers/gemini.ts` is
how Google's names get mapped onto that vocabulary.

## Reporting bugs

Open an issue with your OS, Bun version, the provider involved, and what you expected.
If a provider shows the wrong number, `bun run cli status --json` output is the most
useful thing to paste — it is sanitized, but read it before posting anyway.

## What will be rejected

- Provider parsing or response-shape fixes without a representative sanitized body
- New runtime dependencies without a documented rationale
- Style-only reformatting (whitespace and line-ending noise)
- PRs that mix concerns, or that restructure what they were asked to fix
- Telemetry in any form, or third-party requests from the frontend
- Anything that commits a real credential — the PR gets closed and the token treated
  as leaked: rotate it

## Security

Found something that leaks credentials? Open a
[security advisory](https://github.com/SandroHub013/llm-quota/security/advisories/new)
rather than a public issue.
