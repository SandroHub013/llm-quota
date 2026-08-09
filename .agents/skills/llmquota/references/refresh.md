# Refreshing the ladder

```bash
bun run scripts/refresh-ladder.ts
```

Writes `references/ladder.json`. One board failing does not discard the others —
the failed one is recorded as `{"error": "..."}` in its slot, and the script exits
non-zero only if DeepSWE itself failed.

Refresh when `refreshedAt` is more than 30 days old, and after any flagship
launch. That second trigger is not decoration: in the twelve days after
2026-07-28, Kimi K3 released open weights, DeepSeek shipped V4-Flash-0731, and
Qwen launched 3.8-Max. A table typed by hand at the start of that window had
already missed two of the three and had no way to know.

## Source hierarchy

**1. DeepSWE v1.1 — primary.** `deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json`

Plain JSON, no auth. The only board publishing genuine per-attempt output token
medians (`median_output_tokens`) alongside pass rates and confidence intervals,
which is what makes score-per-token ranking possible at all. 113 tasks, 4 full
runs per config.

Caveats it states itself: the top configs' confidence intervals overlap, so it
separates tiers rather than neighbours — that is what `topBand` encodes. And
"contamination free" covers the tasks and solutions, not the repositories:
`PROVENANCE.md` lists 91 real public projects that are certainly in pretraining
data. Do not mix v1 and v1.1 figures; the frozen v1 artifact reports different
numbers for the same configs.

**2. Terminal-Bench 2.1 — secondary, weight it lightly.**

POST `https://ofhuhcpkvzjlejydnvyd.supabase.co/functions/v1/leaderboard-read`
with header `apikey: sb_publishable_...` (the publishable key the public page
sends) and body `{"package":"terminal-bench/terminal-bench-2-1","name":"main",...}`.

The GitHub file at `harbor-framework/terminal-bench-2-1/.../leaderboard.yaml` is
**not** a fallback: it holds the leaderboard's schema, not its rows.

Three reasons not to lean on it. It had 17 entries with the newest dated
2026-07-11, and Opus 5, GPT-5.6 Sol and Kimi K3 were absent entirely. Every row
is a model *and* an agent harness, never a bare model — Fable 5 scores 83.82
under Claude Code and 80.45 under Terminus 2, so roughly three points belong to
the harness. And the vendor claims do not reconcile with the board: Moonshot
publishes 88.3 for Kimi K3 on TB 2.1, which has no Kimi K3 entry and whose
leader sits at 83.82.

That last point is worth stating plainly: the three flagship vendors all cite
this benchmark and none of them appear on it.

**3. LMArena WebDev — tie-break only.**
`datasets-server.huggingface.co/rows?dataset=lmarena-ai%2Fleaderboard-dataset&config=webdev&split=latest`

Human preference, not throughput, and it publishes no token counts, so it never
overrides token economics. The WebDev arena is used rather than the overall one
because it reorders heavily and is closer to coding — but note it has **no
style-controlled variant**, so it is uncontrolled for verbosity. Since
2026-07-30 new models are seeded with reward-model votes rather than human ones,
so low-vote entries may not be human-derived at all.

**4. CursorBench — advisory only, never for ranking.** See `cursorbench.md`.

## Verification standard

Search results in this space are dominated by aggregator content carrying
numbers that appear on no official page. When updating anything by hand:

- Every figure gets the URL of the vendor page or model card it was read on.
- A verified "not published" beats a plausible reconstruction. Record the gap.
- Vendor launch-day claims are claims until an independent board reproduces them.
  The circulating "Kimi K3 scores 76.8% on SWE-bench Verified" appears on no
  Moonshot page; the model card omits SWE-bench Verified entirely.
- No vendor in the July–August 2026 window published a SWE-bench Verified number
  at all. Its absence from a model card is now normal and is not a signal.
