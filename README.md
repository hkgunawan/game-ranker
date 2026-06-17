# game-ranker

[![CI](https://github.com/hkgunawan/game-ranker/actions/workflows/ci.yml/badge.svg)](https://github.com/hkgunawan/game-ranker/actions/workflows/ci.yml)

An interactive leaderboard of the best **PC & PlayStation** games, 2015 → today.
Filter by year, platform and mode; slide the **critics ↔ players** weighting to
re-rank live; every score is broken down on click.

**Stack:** Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4.
Fully static — no runtime API calls, deploys clean to Vercel.

## How it works

The game list is built **fully automatically** from the [RAWG](https://rawg.io)
database (`src/data/games.json`) — no hand-curation, so new releases appear on
their own. `scripts/fetch-rawg.mjs` discovers PC + PlayStation titles released
2015 → today in two passes:

- **critically acclaimed** — Metacritic ≥ 75
- **popular & well-rated** — most-added titles, kept only if the community rates
  them well with a real sample (filters out shovelware)

Each kept game then gets real **player sentiment** from Steam (% of reviews
positive + count), layered on by `scripts/enrich-steam.mjs`. Titles not on Steam
fall back to the RAWG community rating.

A GitHub Actions cron (`.github/workflows/refresh.yml`) re-runs this every week
and commits the result, which triggers Vercel to redeploy — so the board stays
current with zero manual work.

### The ranking algorithm (`src/lib/rank.ts`)

Up to three signals, all normalized to /100, drive one composite:

- **critics** — Metacritic aggregate
- **players** — Steam % positive (or, with no Steam data, the RAWG community rating ×20)

```
composite = critics·(1 − w′) + players·w′
```

- **w** is the player weight, set live in the UI (0 = critics only, 1 = players only).
  It **defaults player-heavy** (`0.7`) — pro scores can drift from how people who
  actually play the game feel, and large-sample player sentiment is harder to skew.
- **w′** scales `w` by sample-size confidence: a verdict from a million reviews
  counts fully, a thin one counts less. No critic score → players alone; no player
  data → critics alone.

Scores are **global** — filtering changes what's shown, not the scores.

## Develop

```bash
npm install
RAWG_API_KEY=xxxx npm run data   # rebuild src/data/games.json from RAWG (free key: rawg.io/apidocs)
npm run enrich                   # add Steam player sentiment (run after `data`)
RAWG_API_KEY=xxxx npm run refresh # data + enrich in one go
npm run dev                      # http://localhost:3000
npm run lint
npm test                         # vitest — algorithm + filter unit tests
npm run build
```

> The weekly refresh needs a `RAWG_API_KEY` repo secret (free, no card, 20k req/month).
> The legacy markdown-doc parser is kept as `npm run data:docs` for reference.

_Opinionated, for fun. Not affiliated with any publisher._
