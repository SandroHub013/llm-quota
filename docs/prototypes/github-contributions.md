# PROTOTYPE — token spend and GitHub activity card

Question: **how should daily token spend and GitHub activity share one useful dashboard surface without forcing desktop scrolling?**

This prototype deliberately lives only on `prototype/github-contributions-card`. Run it with:

```powershell
bun run dev
```

Then compare the three variants on the existing dashboard:

- `http://localhost:4747/?variant=A` — token-spend calendar with a GitHub toggle
- `http://localhost:4747/?variant=B` — token and GitHub calendars side by side
- `http://localhost:4747/?variant=C` — monthly token-cost/GitHub correlation

The floating switcher and the left/right arrow keys cycle variants without reloading the page. Without a `variant` parameter, A is rendered without prototype controls.

## Data and privacy

- Uses the official `gh api graphql` command and the already-authenticated GitHub CLI viewer.
- Reads GitHub's one-year `contributionsCollection` calendar plus commit, pull-request, issue and review counts.
- Reads the real timestamps stored in Codex, Claude Code, OpenCode and Kimi Code logs.
- Aggregates each day into tokens, cache, output, reasoning, calls, pricing coverage and estimated API-equivalent euros.
- Computes active days, current streak, longest streak and busiest day locally.
- Keeps results in memory for ten minutes; no persistent cache is added.
- The GitHub credential never enters the browser or the LLM Quota process.
- Private contribution counts depend on the token scope and the user's GitHub profile settings.

## Current verdict

**A — Token spend with GitHub toggle** is the strongest fit. It answers the product's local-usage question first, keeps the detailed ledger one click away and preserves the familiar GitHub calendar behind an explicit button. B is the best direct comparison view; C is useful for investigating correlation but is denser than a quota dashboard needs to be.

On desktop viewports at least 850px tall, the activity surface spans the strip below the provider columns—the unused area identified during visual review. On shorter laptops it returns to the masonry as the sixth card. All variants have zero horizontal and vertical overflow at 1920×1080, 1440×900, 1366×768 and 1280×720. Mobile remains a deliberate single-column scrolling layout so the data is not compressed beyond usefulness.

After validation, rewrite the winner as production code and remove this document, both `.prototype.*` modules, the losing variants and the switcher from the main branch.

## OpenCode Zen finding

The Zen models endpoint exposes catalog fields only (`id`, `object`, `created`, `owned_by`) and no quota/rate-limit headers. The prior aggregate `100%` was therefore not a real quota. OpenCode Zen is now omitted from the visible quota cards and reset horizon; its local history remains available to the token ledger. A quota card can return only if Zen publishes usage, limit and reset counters.

Provider cards now lead with the percentage remaining rather than percentage consumed. This matches the dashboard's immediate job—showing how much capacity is still available—while the reset horizon continues to use consumption internally to express urgency.
