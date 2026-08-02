# PROTOTYPE — GitHub contribution card

Question: **which GitHub contribution-card layout belongs below the quota providers without turning LLM Quota into a generic analytics dashboard?**

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

**B — Activity split** is the strongest fit. It preserves the recognizable contribution heatmap, gives streaks and contribution types a clear hierarchy, and is considerably shorter than the monthly mosaic. A is the safest conventional option; C is useful but pushes the product too far toward a general activity dashboard.

After validation, rewrite the winner as production code and remove this document, both `.prototype.*` modules, the losing variants and the switcher from the main branch.

## OpenCode Zen finding

The Zen models endpoint exposes catalog fields only (`id`, `object`, `created`, `owned_by`) and no quota/rate-limit headers. The prior aggregate `100%` was therefore not a real quota. This branch replaces it with one honest `free · fair use` availability row per listed free model. Numeric percentages can be added only if Zen publishes usage, limit and reset counters in the future.
