# PROTOTYPE — GitHub contribution card

Question: **which compact GitHub contribution card can join the quota grid without turning LLM Quota into a generic analytics dashboard or forcing desktop scrolling?**

This prototype deliberately lives only on `prototype/github-contributions-card`. Run it with:

```powershell
bun run dev
```

Then compare the three variants on the existing dashboard:

- `http://localhost:4747/?variant=A` — calendar first
- `http://localhost:4747/?variant=B` — activity split
- `http://localhost:4747/?variant=C` — monthly mosaic

The floating switcher and the left/right arrow keys cycle variants without reloading the page. Without a `variant` parameter, A is rendered without prototype controls.

## Data and privacy

- Uses the official `gh api graphql` command and the already-authenticated GitHub CLI viewer.
- Reads GitHub's one-year `contributionsCollection` calendar plus commit, pull-request, issue and review counts.
- Computes active days, current streak, longest streak and busiest day locally.
- Keeps results in memory for ten minutes; no persistent cache is added.
- The GitHub credential never enters the browser or the LLM Quota process.
- Private contribution counts depend on the token scope and the user's GitHub profile settings.

## Current verdict

**B — Activity split** is the strongest fit. It preserves the recognizable contribution heatmap while putting total, active days and streaks before it. A is the safest conventional option; C is useful but pushes the product farther toward a general activity dashboard.

GitHub is now the sixth visible card in the four-column masonry, alongside five providers with measurable quotas. All three variants have zero horizontal and vertical overflow at 1920×1080, 1440×900, 1366×768 and 1280×720. Mobile remains a deliberate single-column scrolling layout so the data is not compressed beyond usefulness.

After validation, rewrite the winner as production code and remove this document, both `.prototype.*` modules, the losing variants and the switcher from the main branch.

## OpenCode Zen finding

The Zen models endpoint exposes catalog fields only (`id`, `object`, `created`, `owned_by`) and no quota/rate-limit headers. The prior aggregate `100%` was therefore not a real quota. OpenCode Zen is now omitted from the visible quota cards and reset horizon; its local history remains available to the token ledger. A quota card can return only if Zen publishes usage, limit and reset counters.

Provider cards now lead with the percentage remaining rather than percentage consumed. This matches the dashboard's immediate job—showing how much capacity is still available—while the reset horizon continues to use consumption internally to express urgency.
