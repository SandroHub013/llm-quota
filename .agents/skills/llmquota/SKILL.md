---
name: llmquota
description: >
  Quota-driven multi-orchestrator. Reads live provider quotas from the
  llm-quota CLI, classifies the incoming task, picks the cheapest worker CLI
  that still has quota (Gemini→agy, Anthropic→Claude Code, GPT→Codex,
  OpenCode Zen/OpenRouter free/Z.AI→pi, Moonshot→kimi), selects model AND
  effort per task from CursorBench/DeepSWE score-vs-token data (low token
  consumption first, precision as the constraint), degrades gracefully as
  quotas drain (adaptive glidepath), and reviews/validates every worker
  result before accepting it. The orchestrator is always a smarter model
  than its workers — or the same model at higher effort. Sets caveman and
  ponytail levels per channel to keep inter-agent token spend minimal.
  Use on /llmquota, "orchestrate with quota", "route by quota",
  "pick model per quota", "dispatch agents by quota",
  "multi-agent with review", "benchmark-ranked routing".
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

### 4. Model and effort selection (benchmark-ranked, token-first)

Priority order: **low token consumption first, precision as the
constraint.** Among the configs that are good enough for the task, pick
the one that spends the fewest tokens — not the one with the highest
score.

Ranking data comes from the two boards that publish token counts —
[CursorBench](https://cursor.com/cursorbench) (3.2, output tokens/task)
and [DeepSWE](https://deepswe.datacurve.ai/) (pass@1, output tokens,
long-horizon) — fetched 2026-07-28. Both drift with model releases:
re-fetch monthly, and treat <2-point gaps as noise (their own caveat).

Reference ladder (CursorBench 3.2 score / output tokens per task):

| Config | Score | Out tok | Note |
|---|---|---|---|
| Opus 5 Max | 70.0% | 62k | orchestrator grade (DeepSWE 74%) |
| GPT-5.6 Sol Max | 67.2% | 28k | orchestrator grade (DeepSWE 73%) |
| **Opus 5 High** | **66.7%** | **28k** | best near-top ratio |
| **GPT-5.6 Sol High** | **63.5%** | **14k** | efficiency sweet spot |
| Kimi K3 Max | 60.8% | 38k | DeepSWE 69% — strong for its cost |
| **GPT-5.6 Sol Medium** | **60.0%** | **10k** | efficiency sweet spot |
| Kimi K3 High | 59.7% | 27k | |
| Sonnet 5 High | 56.9% | 39k | |
| GPT-5.6 Terra High | 54.2% | 9k | cheap workhorse |
| GLM 5.2 High | 51.5% | 22k | z.ai via `pi` |
| Gemini 3.6 Flash High | 53.5% | 30k | vision/image via `agy` |
| Kimi K3 Low | 50.5% | 13k | floor for real ships |
| Sonnet 5 Max | 61.5% | **93k** | **dominated** — Opus 5 Low beats it at 18k |
| Gemini 3.1 Pro High | 12% (DeepSWE) | 196k | **dominated** — never route here |

Selection rules:

1. **Satisfice, don't maximize.** Pick the lowest-token config within
   Δ=3 points of the best score available for the task class. High-risk
   tasks: Δ=1. Never chase fractions of a point with 2x tokens (Opus 5
   High→Max buys 3.3 points for 2.2x the tokens — that is a deliberate
   choice, not a default).
2. **Never pick a dominated config** — one where the same provider has a
   config with both higher score and fewer tokens (Sonnet 5 Max vs Opus 5
   Low is the canonical trap).
3. **A too-weak worker wastes more than a strong one.** A failed dispatch
   burns the whole brief + retry loop. Floors: scout ≥ low effort, ship S
   ≥ low/medium, ship M/L ≥ medium. Cheap models with low scores
   (Luna Low 37.6%) lose their savings in retries — avoid below the K3
   Low / Terra Medium line for ships.
4. Worker effort defaults: scout = low, ship S = low/medium, ship M/L =
   medium/high. Never max effort on a worker unless the orchestrator
   itself runs higher.
5. Orchestrator effort = max available, or at minimum one notch above the
   highest worker.
6. When the orchestrator session model is fixed (e.g. this session *is*
   Kimi), workers on the same provider must use a weaker model or lower
   effort — otherwise pick a different provider.

### 4b. Benchmark source hierarchy

Not every board measures what routing needs. Weight them like this:

1. **Token economics — CursorBench + DeepSWE (primary).** The only two
   that publish tokens/task, so they alone can rank `(model, effort)` on
   score-per-token. All ladder numbers above come from them.
2. **Agentic-CLI cross-check — Terminal-Bench 2.0.** Closest to how
   workers actually run (shell, multi-step, long horizon). Sanity-check a
   config here before handing it high-risk ships.
3. **Contamination cross-check — LiveCodeBench, SWE-bench Verified.**
   LiveCodeBench refreshes problems; SWE-bench Verified is human-validated
   but saturated at the frontier (~88–95%), so it separates little —
   a model missing from the top band there is a red flag, a model topping
   it is not proof of superiority.
4. **Non-coding tie-break — LMArena ([arena.ai](https://arena.ai/leaderboard/)).**
   Human-preference Elo over chat/writing/research. It measures taste,
   not throughput, and publishes no token counts, so it **never overrides
   token economics** — use it only to break ties for writing, research,
   and review tasks. Snapshot 2026-07-28 (overall rank): fable-5 #1,
   opus-4.6-thinking #2, opus-5-max #5, opus-5-high #7, kimi-k3-max #11,
   gpt-5.6-sol-xhigh #13, glm-5.2-max #31, sonnet-5-high #43.

Known biases, all four sources: Grok is contaminated on CursorBench
(their own disclosure — discount it); arena Elo rewards answer style
over correctness; vendor-launch numbers (any board's day-0 posts) are
claims until independent runs land; <2-point gaps are noise everywhere.
Re-fetch the primaries monthly and after any flagship launch.

### 5. Adaptive quota glidepath

Routing is not a one-shot decision: re-rank as quota drains, sliding down
deliberately instead of falling off a cliff mid-task.

- **Re-snapshot triggers** (not per dispatch): a `rate_limited`/`error`
  status, a mid-task quota failure, every ~5 dispatches, or when a
  provider crosses a band boundary.
- **Bands per provider** (`remaining`):
  - `>50%` normal: policy as above.
  - `20–50%` conservation: drop worker effort one notch, move all scouts
    and S-ships to the free tier, batch independent dispatches into one
    worker run instead of two.
  - `≤20%` skip: route around the provider entirely (the llm-quota exit
    code 1 band) unless it is the last one standing — and then tell the
    user before spending it.
- **Orchestrator re-check on every band change:** superiority is evaluated
  against the *current* ladder. If workers slide down, the orchestrator
  keeps its model/effort; if the orchestrator's own provider enters
  conservation, say so — review quality is the last thing to degrade.
- **Near-total depletion:** free tier (`opencode-zen` / `openrouter` via
  `pi`) + decompose L→M→S + state the expected quality loss to the user.
  Never silently ship free-tier output as if it were frontier work.
- **Reset-aware spending:** a provider with `resetAt` close and low
  `remaining` is for scouts only until it resets; a fresh reset re-opens
  the normal band.

### 6. Dispatch mechanics

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

### 7. Review and validation loop

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

## Capability cards (input / output / context)

What each model can receive and emit, and how much it can hold. This
table is **hardcoded and dated** — fetched 2026-07-28. It is the default,
never the source of truth: modality support and context caps drift with
CLI and model releases, so any routing decision that *hinges* on a cell
of this table must be verified live first (see the rules below).

| Model | CLI | Input | Output | Context (spec) | Context (effective) |
|---|---|---|---|---|---|
| Opus 5 / Sonnet 5 | `claude` | text, image, PDF | text | Sonnet 5: 1M | confirm `/status` |
| GPT-5.6 Sol/Terra/Luna | `codex` | text, image | text | 1.05M, 128K out | **~272K** — see below |
| Kimi K3 | `kimi` | text, image, audio, video | text | confirm `/status` | same |
| GLM 5.2 | `pi` | text (vision on 5V variants) | text | 1M | provider-dependent |
| Gemini 3.6 Flash | `agy` | text, image, audio, video | text, **image** | 1M, 64K out | full 1M |
| Seedance 2.0 (`bytedance/seedance-2.0`) | OpenRouter video API | text, image, audio, video | **video** (+native audio) | 480p–4K, 4–15s clips | pay-per-second |
| OpenCode Zen / OpenRouter free | `pi` | varies, mostly text | text | per model | per model |

Rules:

- **Trust the effective window, never the spec.** GPT-5.6 advertises
  1.05M, but the Codex CLI catalog caps it: 372K until OpenAI silently
  cut it to **272K on 2026-07-18** (some `codex exec` versions reported
  ~258K). Interactive `/status` shows the real number — check it at
  dispatch time, because these caps drift without announcement
  (openai/codex#31860, #32806, #33478; oh-my-pi#6371).
- **Briefs must fit the effective window** minus the output budget (128K
  on GPT-5.6, 64K on Gemini Flash). A task whose input exceeds the
  effective window is a decompose-or-reroute decision: monorepo-wide
  audits and long-document work go to a provider whose *effective* window
  is 1M (Sonnet 5, Kimi K3, GLM 5.2, Gemini), not to Codex at 272K.
- **Modality routing:** audio/video input → Kimi K3 or Gemini (the only
  ones that accept them). Image input → any card above except text-only
  free models. Image **output** → Gemini via `agy` only. PDF → Claude.
- **Video output: deterministic first, generative when there is no DOM.**
  If the shot's source is UI/DOM (a dashboard, a widget, a site), render
  it with HyperFrames — free, pixel-perfect text by construction, and the
  composition stays in the repo for free re-renders. Seedance earns its
  per-second price only for generative/organic content with no DOM
  source (product beauty shots, scenes, footage-like motion). The first
  live runs proved the split: Seedance's best UI result was the one
  where it behaved like a deterministic renderer, and its failures were
  all text reinvention.
  When Seedance IS the right tool — `bytedance/seedance-2.0` via the
  OpenRouter video API (async: `POST /api/v1/videos`, poll the returned
  `polling_url`, download from `<polling_url>/content?index=0` — not a
  chat call, so it does not go through `pi`). Field notes (2026-07-28):
  - Image-to-video inputs must be **publicly downloadable URLs**;
    `raw.githubusercontent.com` links work fine.
  - Always pass `"generate_audio": false` for UI/ambient clips — an
    audio-generating job can die in moderation ("output audio may
    contain sensitive information") after burning queue time.
  - **480p drafts judge motion only, never text fidelity.** At 480p the
    model reinvents small UI text (invented numbers, morphed names —
    false negative); at 1080p, matching the first frame's resolution,
    the same clip keeps text pixel-stable. Judge text at the target
    resolution or the draft will talk you out of a good shot.
  - Text-dense inputs survive best when the text is large in frame
    (upscale small UI onto a brand-dark 16:9 canvas first).
  - Cost discipline: motion drafts on `seedance-2.0-fast`/480p
    (~$0.27/5s), final render on `seedance-2.0` at target resolution
    (~$1.70/5s at 1080p) — billing is per second of output, so every
    rejected draft at 4K is real money, not quota.
- **Verify live when a decision hinges on a cell.** Before dispatching a
  task whose point is a modality (audio in, image out, PDF) or a context
  size, confirm against the live source — the CLI's `/status` / `--help`
  or the provider's current model card — not this table. If live data
  contradicts the table, trust live data and update the table in the same
  session.
- Free-tier cards (OpenCode Zen / OpenRouter) differ per model: read the
  model card before routing anything but plain text.

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
  on the glidepath triggers (section 5), never on every dispatch.

## Boundaries with related skills

- `herdr-orchestration`: durable, visible parallel fleet in the herdr
  terminal — use it for the execution layer when tasks are long, parallel,
  or unattended. llmquota remains the routing/review brain.
- `cavecrew`: in-session compressed subagents; cheapest option when no
  external CLI quota needs spending.
- `caveman` / `ponytail`: llmquota *sets their levels*; their own skills
  define the formats.
