---
name: llmquota
description: >
  Quota-driven multi-orchestrator. Reads live per-window provider quota from the
  llm-quota CLI, takes an admission slot before spending any of it, classifies the
  incoming task, routes it to a worker CLI, and picks model AND reasoning effort as
  a pair from a generated DeepSWE ladder that marks dominated configs mechanically.
  Degrades deliberately as quota drains and reviews every worker result before
  accepting it. Use on /llmquota, "orchestrate with quota", "route by quota",
  "pick model per quota", "dispatch agents by quota", "multi-agent with review",
  "benchmark-ranked routing", "which model should run this".
metadata:
  tags: [orchestration, quota, routing, benchmarks, admission-control]
  related_skills: [cavecrew, caveman, ponytail]
---

# llmquota — quota-driven multi-orchestrator

One orchestrator, many worker CLIs. The orchestrator never trusts a worker: it
dispatches narrow briefs, collects conclusions, reads the diffs, runs the
verification itself, and only then accepts the work.

This file is policy. The numbers live in `references/ladder.json`, which is
generated — never hand-edit it, and never quote a benchmark figure from memory.

## Invariants

- **Spend nothing without a slot.** Every dispatch that consumes metered quota
  takes a reservation first and releases it after. A quota reading is a state
  check; the reservation is what stops parallel workers from clearing the same
  floor and emptying the provider together.
- **Absent quota is `unknown`, never `unlimited`.** A worker whose capacity this
  tool cannot see gets one probe at a time and no automatic retry.
- **Effort is a routing decision.** Model and effort are chosen as a pair, per
  task, never model first.
- **Workers return conclusions, not transcripts.** Full logs stay on disk.
- **No blind acceptance.** A result counts after the orchestrator has read the
  diff and watched the verification pass — not after the worker says it passed.

## 1. Snapshot

```bash
llm-quota snapshot --json     # every window per provider, plus which one binds
```

Exit codes are data: `0` healthy, `1` a provider at or below the 20% floor,
`2` provider error, `3` server offline or bad arguments.

Use `snapshot`, not `status`. `status` collapses each provider to its worst
window, which answers "may I dispatch" and nothing else. Antigravity splits its
plan into separate pools, so the provider-wide minimum can reject a Gemini bucket
that is full and is exactly the one a vision task needs. `snapshot` gives every
window, its reset, and the `binding` one.

On exit `3` the server is down. Do not "fall back to the HTTP API" — the CLI *is*
that call. Ask the user to start `bun start`, or proceed with unobserved workers
only, saying so.

## 2. Reserve before dispatching

```bash
llm-quota reserve claude --json    # exit 0 granted, 1 denied
llm-quota release <id>             # always, including on failure
```

Slots come from the binding window: `>50%` → 3 concurrent, `20–50%` → 1, `≤20%`
→ 0. Reservations expire after 30 minutes so a crashed worker cannot hold a slot
forever.

Denied with `floor` means route elsewhere. Denied with `saturated` means wait or
route elsewhere — never launch anyway.

## 3. Triage

One line, before routing:

- **kind**: `scout` (read-only) | `ship` (writes code) | `review` (audits a diff)
  | `vision`/`image`
- **size**: S (1–2 files) | M (single module) | L (cross-cutting)
- **risk**: low | high (auth, data, money, public API)

## 4. Worker classes

Two classes, different rules. Do not merge them.

**Observed** — quota visible, admission-controlled:

| Provider id | Worker CLI | Notes |
|---|---|---|
| `claude` | Claude Code | effort ladder low→max |
| `codex` | Codex CLI | effort ladder low→max |
| `gemini` | Antigravity / `agy` | pooled buckets; vision and image |

**Unobserved** — usable, never the default absorber:

| Worker CLI | Reaches | Rule |
|---|---|---|
| `pi` | OpenRouter, GLM, DeepSeek | one in flight, low-risk scouts only |
| `kimi` | Kimi Code | one in flight, low-risk scouts only |

For unobserved workers: no automatic retry, a circuit breaker after any
rate-limit error, and ships or high-risk work only on explicit user opt-in. Say
in the report that the worker was unobserved. "Free tier absorbs the scouts" is
not a policy this tool can support — a price of zero is not a request budget, and
routing the bulk of work at the one thing you cannot measure means the first
thing you exhaust is the thing you cannot see coming.

## 5. Model and effort

Read `references/ladder.json`. It carries, per `(model, effort, harness)`:
`passAt1`, `ciLo`/`ciHi`, `outputTokens` (median, genuine output), `costUsd`,
`dominated` + `dominatedBy`, and `topBand`.

Rules, in order:

1. **Never select a config where `dominated` is true.** Some other config scores
   at least as well on strictly fewer output tokens. The flag is computed, not
   argued: at the last refresh 40 of 53 configs were dominated.
2. **Inside `topBand`, rank on tokens, not score.** Every top-band config's
   confidence interval overlaps the leader's, so the score differences there are
   not real. Pick the cheapest one that clears the task's floor.
3. **Effort returns go flat above `high`.** Check `primary.effortLadders` for the
   model you are about to use. Default worker ceiling is `high`; going past it
   needs a stated reason, not a preference.
4. **A too-weak worker costs more than a strong one.** A failed dispatch burns
   the brief, the retry and the review. Floors: scout ≥ `low`, ship S ≥ `medium`,
   ship M/L ≥ `high`.
5. **Reviewer floor, not "smarter reviewer".** Cross-provider "smarter" is not
   knowable from a coding benchmark. Require instead: the reviewer sits in
   `topBand`, and it is a different provider from the implementer where quota
   allows. Verification the orchestrator runs itself is what actually catches the
   error.

If the ladder's `refreshedAt` is more than 30 days old, refresh it before quoting
it — see `references/refresh.md`. If you cannot, say the numbers are stale
instead of presenting them as current.

## 6. Closed loop

`llm-quota usage --json` reports what each `(model, effort)` actually cost on
this machine: tokens, calls, context reuse, API-equivalent euros.

Two cautions before routing on it:

- `calls` counts model turns, not completed tasks, and the ledger records neither
  task class nor whether the result was accepted. Cost per call is not cost per
  task. To rank on local data you must record your own dispatch journal — task
  kind and size, config used, ledger delta, outcome, retries, reviewer cost.
- `costEur` is API-equivalent pricing, not what a subscription actually debits.
  For quota conservation reason in **tokens and observed window deltas**.

Blend, once you have a journal: `w = n / (n + 20)`, where `n` is comparable
completed dispatches. Benchmarks set the quality floor; local evidence sets the
cost estimate. At `n = 0` the benchmark prior decides everything, at `n = 20` they
weigh equally. Explore only on low-risk tasks.

`contextReusePct` is a routing signal too: a worker with warm cache is cheap to
re-dispatch, a cold one is not. It should influence batching, not quality.

## 7. Glidepath

Bands are per provider, read from the **binding** window:

- `>50%` — normal policy.
- `20–50%` — one worker at a time (the reservation enforces it), drop worker
  effort one notch, batch independent dispatches into one run.
- `≤20%` — reservations are refused. Route around. If it is the last provider
  standing, tell the user before asking them to override.

Re-snapshot when a reservation is denied, on any `rate_limited` or `error`
status, and after any dispatch that ran longer than a few minutes. `/api/quota`
caches for 55 seconds, so two snapshots inside the same minute return the same
numbers — do not read that as stability.

A provider whose binding window resets soon is worth waiting for. `snapshot`
gives every reset; use them.

## 8. Dispatch

- **S, one-shot:** headless print mode, one process, conclusion back — `claude -p`,
  `codex exec`, `agy -p`, `pi -p`, `kimi -p`. Flags drift: confirm with
  `<cli> --help` before first use.
- **Parallel:** run as background tasks so workers overlap, but never more than
  the granted slots.
- **In-session:** `cavecrew` presets (investigator / builder / reviewer) when the
  work needs no separate CLI. They cost roughly a third of the context.
- **Writers in isolation:** for anything that edits files, give each worker its
  own worktree and make the merge conditional on the review and the verification
  passing. A claim that the diff was reviewed is not enforcement.

Briefs are narrow: goal, exact `path:line` anchors, constraints, done criteria.
Never paste files a worker can open itself.

## 9. Review loop

For every worker result:

1. Read `git diff`, not the worker's prose about the diff.
2. Run the verification it claims — `bun test`, `tsc --noEmit` — and read the
   real output.
3. Delete pass: reinvented stdlib, unneeded abstraction, dead flexibility.
4. Check against the original done criteria.

On failure: retry once with a tighter brief; on the second, re-route up the
ladder; on the third, stop and report what is known. A worker that fails on quota
mid-task is re-routed, not retried in place — and its reservation is released
first.

## Reporting

Say which provider and `(model, effort)` ran each piece, what it cost in tokens,
and whether any of it came from an unobserved worker. If quota forced a
downgrade, say what was given up. Never present free-tier or degraded output as
frontier work.
