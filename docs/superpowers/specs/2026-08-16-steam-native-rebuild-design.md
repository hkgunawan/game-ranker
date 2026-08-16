# Steam-native rebuild: fix recency, drop RAWG

**Date:** 2026-08-16
**Status:** approved, ready for planning

## Problem

Three faults, discovered together. Only the third was visible from outside.

### 1. New releases cannot reach the board

Release-year coverage in the live dataset:

```
2015: 75   2018: 58   2021:  39   2024: 56
2016: 94   2019: 64   2022: 140   2025: 31
2017: 90   2020: 60   2023:  85   2026:  6
```

`scripts/fetch-rawg.mjs` runs a "recent" pass with `RECENT_RESERVE = 320`
slots, ordered by RAWG's `-added` (cumulative collection adds). The 2022-2026
rows sum to **318**. The pass hits its cap almost exactly.

`-added` is cumulative, so it measures age as much as quality: a 2022 title has
had four years to collect adds, a 2026 title a few weeks. The reserve fills with
2022-2023 games and the pass breaks before reaching the current year.

`RECENT_MIN_RATINGS_COUNT = 40` contributes at the newest edge but is not the
binding constraint. The cap plus the ordering is.

### 2. Recent games bypass the confidence system

RAWG's `metacritic` field is null for every 2025 and 2026 game in the dataset.
That routes all of them through this branch of `rank()`:

```ts
} else if (crit == null) {
  composite = ps!.score;   // players-only
  effW = 1;
}
```

Confidence is skipped. A game with 200 Steam reviews at 98% positive scores a
flat 98 and lands in S tier, above The Witcher 3, on a sample the algorithm
would otherwise barely trust. The `provisional` flag marks such games in the UI
but does not affect the score.

Fixing discovery without fixing this would fill the top of the board with
thinly-reviewed new releases.

### 3. RAWG has been down for five weeks

`https://api.rawg.io/api/games` returns HTTP 522 after a ~20s hang, verified
2026-08-16. Last successful data commit: 2026-07-27. The weekly cron has failed
on 2026-08-03, 08-10 and 08-15; the alert issue is open and correct.

## Decisions taken

Two product decisions, both settled before design:

- **A game appears once it has real sentiment**, not at launch. No separate
  "just released" surface. The eligibility gate and the trust gate become one
  rule.
- **PC-only.** PlayStation coverage is dropped. This removes the need for a
  games database entirely.

## Approach

**Steam-native, with SteamSpy for discovery.** Rejected alternatives:

- *Official Steam endpoints only.* Paging `Released_DESC` down to a saved
  watermark has a structural hole: a game that finds its audience three months
  after launch is already behind the watermark and is never reconsidered.
  Closing that needs a cross-run watchlist. It also requires scraping appids out
  of image URLs, because Steam's search JSON returns only `name` and `logo`, and
  its `sort_by=Reviews_DESC` does not order by review count (observed: *A Short
  Hike, The WereCleaner, Papa's Freezeria Deluxe*).
- *IGDB as the games database, Steam for sentiment.* Its sole advantage is
  console coverage, which is out of scope by decision. It costs Twitch OAuth, a
  second query language, and reintroduces the dependency class that caused the
  outage.

Two facts make the Steam-native approach work, both verified against the live
APIs on 2026-08-16:

```
appdetails(1245620)  ->  metacritic: {"score": 94, ...}
                         release_date, genres, categories, developers, type
steamspy(all,page=1) ->  1000 apps, with appid/name/developer/positive/negative
```

Metacritic lives inside Steam's own app data, so dropping RAWG does not cost the
critic signal.

## Design

### Pipeline

`scripts/fetch-steam.mjs` replaces `fetch-rawg.mjs`.

Six ordered stages. The order matters: release date and `type` are only known
after the detail call, so the eligibility rule cannot be applied in one pass.

| # | Stage | Source | Calls | Known after this stage |
|---|---|---|---|---|
| 1 | Discover | `steamspy.com/api.php?request=all&page=0..9` | 10 | appid, name, developer, positive, negative (~10,000 rows) |
| 2 | Sentiment gate | -- | 0 | survivors of the review-count and positive-% rule (~3,500) |
| 3 | Detail | `store.steampowered.com/api/appdetails` | ~3,500 | `type`, release date, genres, categories, blurb, Metacritic |
| 4 | Catalogue gate | -- | 0 | survivors of the `type` and release-year rule (~2,400) |
| 5 | Rank and cap | -- | 0 | top 1,000 by composite, per-year floor applied |
| 6 | Exact sentiment | `store.steampowered.com/appreviews` | ~1,000 | precise positive/total, replacing SteamSpy's approximations |

Stage 5 ranks on SteamSpy's review counts, because fetching exact counts for
2,400 games to then discard 1,400 of them is wasted. Stage 6 refreshes only the
survivors, so final published scores move slightly from the ones used to cap. A
game near the boundary can therefore end up marginally below the bar it was
selected on; this is accepted rather than iterated, since a second pass would
have the same property.

Call-count figures are estimates from a single SteamSpy page; the implementation
logs actuals.

Pacing: 250 ms between Steam calls, the spacing `enrich-steam.mjs` already uses
in production. A green refresh took 13 minutes for ~1,400 Steam calls, so ~30
min/week is the expected shape. SteamSpy's `all` endpoint is capped at 1
req/min, making discovery ~10 minutes of mostly waiting.

`getJson()` currently throws on any non-OK response. Add retry with backoff on
429 and 5xx, matching the shape already in `fetch-rawg.mjs`.

**No metadata cache.** Release dates and genres never change, so caching
appdetails in a committed file would make weekly runs nearly free. At 250 ms the
run is already affordable, so the cache buys a 30-minute job becoming a
10-minute one at the cost of a second persisted file and staleness bugs. Revisit
only if Steam throttles the longer run.

**Deleted:** the fuzzy title-matching layer in `enrich-steam.mjs` --
normalization, Jaccard scoring, roman-numeral mapping, the sequel-number guard,
the manual appid override table. It exists only because RAWG supplied titles and
the appid had to be guessed. Discovery now starts from appids.

### Eligibility

One rule replaces the two competing gates, applied in two parts because of what
is known when (see the stage table above):

```
stage 2, from SteamSpy:      totalReviews >= 2_000   # "real sentiment", typically 2-6 weeks post-launch
                             positivePercent >= 75

stage 4, from appdetails:    type === "game"         # excludes DLC, soundtracks, tools
                             releaseYear >= 2015
```

Then cap at **1,000 games by composite score**, with a **floor of 40 per release
year**. All four constants are tunable during implementation against the real
distribution; the floor must not exceed the cap divided by the number of years
in range.

Why cap: the board is a static page that ships every game to the client. At 524
bytes/game, today's 798 games are 514 KB. The gate above is estimated to pass
~2,400, a 1.25 MB payload. A thousand keeps it near today's weight.

Why the per-year floor: ranking the cap by score rather than by cumulative
popularity removes most of the age bias that caused fault 1; the floor
guarantees the rest. A game qualifies on merit, not on having existed long
enough to accumulate adds.

### Scoring

Replace the confidence bypass:

```ts
} else if (crit == null) {
  composite = ps!.score * conf + boardPrior * (1 - conf);
}
```

A thin sample is pulled toward the board average; a large one is barely moved.
At the 2,000-review floor `conf` is about 0.77, so shrinkage tops out near 23% --
enough to stop launch-week inflation, not enough to bury a genuinely strong
game.

This makes `prior()` live. It is currently exported and unit-tested but never
called by `rank()`. Change it to average the **player** signal rather than
critic scores, so both sides of the blend sit on one scale.

`rawgToPercent()` and the RAWG branch of `playerSignal()` become unreachable --
every game now carries Steam data by construction. Delete both. The `ps == null`
branch of `rank()` likewise becomes unreachable and should be removed rather
than left as dead defence.

### Application changes

- `platforms` collapses to PC. The platform filter control, the "PC &
  PlayStation" copy, the README, and the OpenGraph image template all lose the
  cross-platform framing.
- `Game` drops `rawgSlug`, `rawgRating`, `rawgRatingsCount`. `steamAppId`
  becomes required rather than nullable.
- Per-game links point at the Steam store page instead of RAWG.
- `scripts/fetch-rawg.mjs` and the legacy `scripts/parse-games.mjs` are deleted.

41 games leave the board, 5% of the total, including Bloodborne, The Last of Us
Part II, Uncharted 4 and Ratchet & Clank.

### Failure handling

Reuse the pattern already in `refresh.yml`: preflight probe, `exit 75` on
upstream failure, never overwrite good data, open and auto-close a single alert
issue. Three additions:

- Preflight probes **SteamSpy and Steam separately** and names which is down.
  They have independent failure modes; conflating them is what made the RAWG
  outage ambiguous for weeks.
- A **board-size floor**: refuse to write if the new board is under 80% of the
  previous one. A partial run must not gut the site.
- The workflow's alert step must fire on cancellation as well as failure
  (`if: failure() || cancelled()`), because a job that exceeds `timeout-minutes`
  is cancelled, not failed, and would otherwise skip the alert.

### Testing

- `src/data/games.test.ts`, in the shape of market-dashboard's
  `signals.test.ts`: no duplicate appids, every game carries a player signal,
  every year from 2015 to the current year holds at least the floor count. That
  last assertion is the regression guard for this whole project -- `2026: 6`
  would have failed it in July.
- `rank.test.ts` gains cases for the shrinkage branch: a thin sample is pulled
  toward the prior, a large sample is not, and the boundary is pinned by
  mutation (removing the shrinkage must fail a test).
- Pure-function tests for the eligibility gate and the per-year-floor cap,
  including the case that caused fault 1: a candidate list dominated by older
  titles must still yield the floor count for the current year.

### Rollout

The first run writes to a side file, not `src/data/games.json`. Diff old against
new -- what left, what arrived, how the top 50 moved -- and switch only after
review. A silent whole-board replacement is not something to discover in
production.

## Risks

- **SteamSpy is a third-party side project** and has had outages. This trades
  RAWG's fragility for SteamSpy's rather than eliminating it. Mitigated by the
  never-overwrite rule, the board-size floor, and separate preflight probing, so
  an outage costs freshness rather than the site. Not mitigated: a permanent
  SteamSpy shutdown would require the watermark-and-watchlist design that was
  rejected above.
- **Board composition shifts.** Steam review counts and Metacritic weight
  differently than RAWG's community rating did; tier boundaries in `tierOf()`
  were calibrated against the RAWG+Steam distribution and will need
  recalibration against the new one. The rollout diff is where this is caught.
- **Steam throttling at 3x the current call volume.** The 250 ms figure is
  proven at ~1,400 calls, not ~4,500. If throttling appears, the metadata cache
  deferred above is the answer.
