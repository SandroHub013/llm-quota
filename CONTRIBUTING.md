# Contributing

Thanks for looking. This is a small project with a small surface, so contributing is meant to be
quick.

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

Both must pass — CI runs exactly these two commands.

## Adding a provider

This is the most useful contribution, and the contract is small. A provider is one file in
`src/providers/` that fetches whatever the service exposes and returns a `QuotaResult`.

1. Read `src/providers/types.ts` for the shape.
2. Copy the closest existing adapter — `moonshot.ts` is the simplest (plain API key),
   `claude.ts` the most complete (OAuth from disk, caching, rate-limit backoff).
3. Register it in `src/providers/index.ts`.
4. If the provider needs a logo, add an official mark to `public/logos/` and reference it — do
   **not** hotlink it. `src/frontend.test.ts` will fail if you do.
5. Add a test next to the adapter (`*.test.ts`) covering at least the parse of a real response
   body, with any credentials scrubbed.

## Ground rules

- **No third-party requests from the frontend.** No CDN, no font host, no favicon service. This
  is the point of the project and `src/frontend.test.ts` enforces it.
- **No telemetry.** Ever.
- **No new runtime dependencies** without a reason in the PR description. The project ships with
  exactly one (`hono`) and that is a feature.
- **Never commit credentials**, and scrub tokens out of test fixtures.

## Localisation

Every user-facing string — dashboard, CLI, widget — is English, hard-coded at its use site.
There is no i18n layer, and adding one is a design decision rather than a translation task:
open an issue first if you want to propose it.

One thing to keep consistent when you touch strings: window labels are named the same way
for every provider (`Session (5h)`, `Weekly (7d)`, `Daily (24h)`), even when the provider
calls them something else. `normaliseLabel` in `src/providers/gemini.ts` is how Google's
names get mapped onto that vocabulary.

## Reporting bugs

Open an issue with your OS, Bun version, the provider involved, and what you expected. If a
provider shows the wrong number, `bun run cli status --json` output is the most useful thing to
paste — it is sanitized, but read it before posting anyway.

## Security

Found something that leaks credentials? Open a
[security advisory](https://github.com/SandroHub013/llm-quota/security/advisories/new) rather than
a public issue.
