# game-ranker

[![CI](https://github.com/hkgunawan/game-ranker/actions/workflows/ci.yml/badge.svg)](https://github.com/hkgunawan/game-ranker/actions/workflows/ci.yml)

An interactive leaderboard of the best **PC & PlayStation** games, 2015 → today.
Filter by year, platform and mode; slide the **critics ↔ players** weighting to
re-rank live; every score is broken down on click.

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4.
Fully static — no runtime API calls, deploys clean to Vercel.

## How it works

The data is a curated, static dataset (`src/data/games.json`, 115 unique titles)
parsed from two source rankings in `data-sources/`:

- **PC** — 93 games scored on a 7-axis /100 rubric (Parts 1, 2, 4; the cross-cut
  Parts 3 & 5 are re-listings and are excluded).
- **PlayStation** — 50 games scored on a 6-axis /100 rubric.

28 titles appear on both platforms and are merged into a single entry.

Each game also carries real **player sentiment** from Steam (% of reviews positive
+ review count), pulled at build time by `scripts/enrich-steam.mjs` for the ~105 of
115 titles on Steam (console exclusives fall back to editorial-only).

### The ranking algorithm (`src/lib/rank.ts`)

The composite blends the curated **editorial** score (critic-anchored) with the
**player** score (Steam % positive):

```
composite = editorial·(1 − w′) + players%·w′
```

- **w** is the player weight, set live in the UI (0 = critics only, 1 = players only).
- **w′** scales `w` by review-volume confidence: a verdict from a million reviews
  counts fully, a thin one counts less, and a game with no Steam data keeps its
  editorial score (`w′ = 0`).

Professional scores can drift from how players actually feel — blending Steam's
large-sample sentiment corrects for that, and the slider lets you decide how much to
trust each side. Scores are **global** — filtering changes what's shown, not the scores.

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
npm run data     # regenerate src/data/games.json from data-sources/*.md
npm run enrich   # add Steam player sentiment to src/data/games.json (run after `data`)
npm run lint
npm test         # vitest — algorithm + filter unit tests
npm run build
```

_Opinionated, for fun. Not affiliated with any publisher._
