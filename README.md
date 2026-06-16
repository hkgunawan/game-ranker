# game-ranker

[![CI](https://github.com/hkgunawan/game-ranker/actions/workflows/ci.yml/badge.svg)](https://github.com/hkgunawan/game-ranker/actions/workflows/ci.yml)

An interactive leaderboard of the best **PC & PlayStation** games, 2015 → today.
Filter by year range and platform; every score is re-computed with one transparent
algorithm and broken down on click.

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4.
Fully static — no runtime API calls, deploys clean to Vercel.

## How it works

The data is a curated, static dataset (`src/data/games.json`, 115 unique titles)
parsed from two source rankings in `data-sources/`:

- **PC** — 93 games scored on a 7-axis /100 rubric (Parts 1, 2, 4; the cross-cut
  Parts 3 & 5 are re-listings and are excluded).
- **PlayStation** — 50 games scored on a 6-axis /100 rubric.

28 titles appear on both platforms and are merged into a single entry.

### The ranking algorithm (`src/lib/rank.ts`)

Both docs score on the same /100 scale, so a naive merge would just average the two
numbers. Instead the scores are weighted by **evidence** and shrunk with a small
**Bayesian model**:

1. **Evidence (n)** — a game reviewed on both platforms carries two independent
   verdicts; older titles have a settled long tail, so they count for more. Releases
   from 2025+ are flagged _provisional_ (their reviews are still settling).
2. **Shrinkage** — `composite = (raw·n + prior·k) / (n + k)`. Thin evidence is pulled
   toward the dataset mean; strong evidence stays at its raw value.
3. **Corroboration** — a small, capped bump when both platforms independently rate a
   game highly.

Net effect: generational cross-platform classics rise, while brand-new
single-platform titles cool off slightly until their long tail settles. Scores are
**global** — filtering changes what's shown, never the scores themselves.

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
npm run data     # regenerate src/data/games.json from data-sources/*.md
npm run lint
npm test         # vitest — algorithm + filter unit tests
npm run build
```

_Opinionated, for fun. Not affiliated with any publisher._
