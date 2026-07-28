---
name: llmquota
description: >
  Quota-driven multi-orchestrator. Reads live provider quotas from the
  llm-quota CLI, classifies the incoming task, picks the cheapest worker CLI
  that still has quota (Gemini→agy, Anthropic→Claude Code, GPT→Codex,
  OpenCode Zen/OpenRouter free/Z.AI→pi, Moonshot→kimi), selects model AND
  effort per task, and reviews/validates every worker result before
  accepting it. The orchestrator is always a smarter model than its workers
  — or the same model at higher effort. Sets caveman and ponytail levels
  per channel to keep inter-agent token spend minimal. Use on /llmquota,
  "orchestrate with quota", "route by quota", "pick model per quota",
  "dispatch agents by quota", "multi-agent with review".
metadata:
  tags: [orchestration, quota, routing, caveman, ponytail, token-economy]
  related_skills: [herdr-orchestration, cavecrew, caveman, ponytail]
---

# llmquota — quota-driven multi-orchestrator

One orchestrator, many worker CLIs. The orchestrator never trusts a worker:
it dispatches narrow briefs, collects conclusions-only results, reviews the
diffs, runs the verification commands, and only then accepts the work.

## Invariants

- **Orchestrator superiority.** The orchestrator model is strictly smarter
  than every worker it launches — or the same model at a strictly higher
  effort. If quota leaves no weaker worker below the orchestrator, the task
  stays with the orchestrator; never launch a worker smarter than its
  reviewer.
- **Effort is a routing decision.** Effort moves quality and token spend
  together, so model and effort are chosen as a pair, per task.
- **Workers return conclusions, not transcripts.** Full logs stay on disk;
  only the compressed result enters orchestrator context.
- **No blind acceptance.** A worker result counts only after the
  orchestrator has reviewed the diff and seen the verification pass.
- **Metered quota is spent on ships, free quota on scouts.** Unmetered
  providers absorb read-only and low-stakes work first.

## Flow

### 1. Quota snapshot

```bash
llm-quota status --json          # or: bun run src/cli.ts status --json
```

Exit codes are data: `0` healthy, `1` some provider ≤20% remaining,
`2` provider error, `3` server offline. On `3`, fall back to the HTTP API
(`curl $LLM_QUOTA_URL/api/quota`, default `http://localhost:4747`); if that
is offline too, route conservatively — free tier for scouts, ask the user
before spending unknown metered quota.

Reduce the payload to `id / status / remaining / resetAt` per provider.
A provider at or below the **20% floor** is skipped unless nothing else is
available. Providers with `status` other than `ok` and no `remaining` are
treated as unavailable.

### 2. Task triage

Classify before routing — one line, in orchestrator context:

- **kind**: `scout` (read-only investigation) | `ship` (writes code) |
  `review` (audit a diff) | `vision`/`image` (needs Gemini)
- **size**: S (1–2 files, obvious scope) | M (single module) | L (cross-cutting)
- **risk**: low | high (auth, data, money, public API)

### 3. Routing table

| Provider (llm-quota id) | Worker CLI | Use for |
|---|---|---|
| `gemini` | `agy` | vision, image, general — Gemini quota |
| `claude` | Claude Code CLI | ships, reviews — `--effort` ladder |
| `codex` | Codex CLI | ships — GPT quota |
| `moonshot` | Kimi CLI | ships, scouts |
| `opencode-zen` | `pi` | free models — unmetered tier |
| `openrouter` | `pi` | `:free` models — unmetered tier |
| `zai` | `pi` | GLM models |

Selection policy, in order:

1. Drop providers below the quota floor or not `ok`.
2. `scout` / low-risk S → **free tier first** (`opencode-zen`, `openrouter`
   via `pi`), then the metered provider with the most `remaining`.
3. `ship` M/L or high-risk → strongest surviving metered provider that
   still satisfies orchestrator superiority.
4. `vision`/`image` → `agy` (Gemini), regardless of the above.
5. `review` → a **different provider than the implementer** when one is
   available, so the reviewer does not share the implementer's blind spots.
6. Everything starved → drop one ambition level (L→M→S decomposition)
   before ever breaching the floor.

### 4. Model and effort selection

Per dispatch, record `(provider, cli, model, effort)`:

- Worker effort defaults: scout = low, ship S = low/medium, ship M/L =
  medium/high. Never max effort on a worker unless the orchestrator itself
  runs higher.
- Orchestrator effort = max available, or at minimum one notch above the
  highest worker.
- When the orchestrator session model is fixed (e.g. this session *is*
  Kimi), workers on the same provider must use a weaker model or lower
  effort — otherwise pick a different provider.

### 5. Dispatch mechanics

- **S tasks, one-shot:** headless print mode, one process, conclusion back:
  `claude -p`, `codex exec`, `agy -p`, `pi -p`, `kimi -p`. Flags drift —
  confirm each CLI's non-interactive mode with `<cli> --help` before first
  use, and run them as background shell tasks so parallel workers overlap.
- **M/L or many parallel tasks:** defer to the `herdr-orchestration` skill
  (durable workers, worktrees, schema-valid reports, its own quota-aware
  router). llmquota sets *who* and *how much effort*; herdr runs the fleet.
- **In-session subagents:** for work that never needs another CLI, the
  `cavecrew` presets (investigator/builder/reviewer) return
  caveman-compressed results and cost ~⅓ the context of vanilla agents.

Briefs are narrow: goal, exact `path:line` anchors, constraints, done
criteria. Never paste file dumps a worker can read itself.

### 6. Review and validation loop

For every worker result:

1. Read the diff (`git diff`), not the worker's prose about the diff.
2. Run the verification the worker claims (`bun test`, `tsc --noEmit`, …)
   and look at the actual result.
3. ponytail-review pass: anything to delete — reinvented stdlib, unneeded
   abstraction, dead flexibility? Send it back if so.
4. Validate against the original done criteria.

On failure: retry once with a tighter brief; on second failure re-route to
the next provider up the ladder; on third, stop and report to the user
with what is known. A worker that fails quota mid-task is re-routed, not
retried in place.

## Verbosity: caveman and ponytail levels

The orchestrator sets compression per channel, based on the verbosity the
task actually needs:

| Channel | caveman level | ponytail |
|---|---|---|
| orchestrator → worker brief | `full` (ultra for mechanical tasks) | on |
| worker → orchestrator result | `ultra`, conclusions only | n/a |
| orchestrator → user | user's preference (default: normal prose) | per user |
| security / irreversible-action warnings | plain language, always | — |

Rules:

- Machine-to-machine text is never prose. If a human will not read it,
  compress it.
- `wenyan-*` levels only when the user writes Chinese.
- Implementation workers run the ponytail stance by default: laziest
  working solution, stdlib first, no speculative configurability, `MINIMAL
  CHANGES` in every brief. Deliberate deferrals are left as `ponytail:`
  comments, not silently dropped.
- If the user asks for verbosity (explain, teach, document), compression
  drops for that channel only — briefs stay compressed.

## Token-minimal IPC

- Pass `path:line` references, not contents. Workers read files
  themselves.
- Large payloads (long briefs, big results) go through files under a temp
  dir; pass the path, read once, delete when done.
- One aggregated worker report per dispatch; no incremental chatter.
- Never relay worker A's raw output into worker B's prompt — the
  orchestrator distills first.
- Quota snapshots are cached for the session's routing decisions; refresh
  after any `rate_limited` / `error` status or a mid-task failure, not on
  every dispatch.

## Boundaries with related skills

- `herdr-orchestration`: durable, visible parallel fleet in the herdr
  terminal — use it for the execution layer when tasks are long, parallel,
  or unattended. llmquota remains the routing/review brain.
- `cavecrew`: in-session compressed subagents; cheapest option when no
  external CLI quota needs spending.
- `caveman` / `ponytail`: llmquota *sets their levels*; their own skills
  define the formats.
