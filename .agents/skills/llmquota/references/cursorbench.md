# CursorBench — why it is not in the ladder

CursorBench publishes the widest `(model, effort)` table anywhere: 53 pairs with
a score, a token count, a cost and a step count. It is deliberately excluded from
`ladder.json`, and it should not be used to rank a routing decision.

## No machine-readable export

Verified negative, not assumed. `/api/cursorbench`, `/cursorbench.json`,
`/api/cursorbench/results`, `/cursorbench/data.json`, `/api/evals` and
`/api/leaderboard` all return 404. The React flight response carries no rows.
`github.com/cursor/eval` does not exist and the public `cursor` organisation
holds no benchmark-data repository. Epoch AI mirrors the board visually but
states it sources from Cursor's page and publishes no CursorBench rows of its own.

The page is server-rendered HTML, so it can be scraped. Nothing here is
automated, because the reasons below make automating it the wrong investment.

## Its token column is not comparable to DeepSWE's

The column is labelled only `Tokens / task`, with no definition on the board.
The methodology post plots score against "median completion tokens", implying
output tokens, but the leaderboard never says so and its cost footnote sums
input, cache-read, cache-write and output. DeepSWE labels its column
`median_output_tokens` explicitly.

Placing the two in one table — which the earlier draft of this skill did — puts a
possibly-total next to a definitely-output and ranks on the difference.

## No error bars, ever

No trial count and no confidence intervals are published anywhere. The only
guidance is the board's own line that results are subject to variance and small
differences may not be meaningful — with no way to tell which differences are
small. DeepSWE publishes run-to-run confidence intervals, so `topBand` can be
computed rather than guessed.

## The tasks are private

Tasks come from Cursor's internal codebase and are graded by agentic graders.
Neither the tasks nor the grading can be inspected or reproduced by anyone
outside Cursor.

## Disclosed contamination

Cursor's own note, verbatim: *"Grok 4.5 has an advantage on CursorBench: an
earlier snapshot of the Cursor codebase was unintentionally included in training.
The exact score impact is unclear."*

## Ownership conflict

SpaceX agreed on 2026-06-16 to acquire Anysphere, Cursor's parent, for $60B,
closing in Q3 2026. Grok 4.5 was co-developed by SpaceXAI together with Cursor,
and is ranked in the board's top ten.

The vendor of a ranked model is acquiring the author of the benchmark. That is a
governance problem, not a methodology footnote, and it is the reason this file
exists rather than a caveat line in the ladder.

## When it is still useful

As a sanity check on breadth. It covers effort ladders for models DeepSWE has not
run, and a config that looks strong on both boards is better evidence than one
strong on either. Read it; do not rank on it.
