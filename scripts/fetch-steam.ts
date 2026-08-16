// Builds the games board from Steam, in six stages:
//
//   1 discover      SteamSpy `all` pages -> ~10k appids with review counts
//   2 sentiment     keep games with a real, positive sample
//   3 detail        Steam appdetails -> type, release date, genres, Metacritic
//   4 catalogue     keep released PC games from 2015 on
//   5 rank + cap    top BOARD_CAP by composite, with a per-year floor
//   6 exact counts  Steam appreviews for the survivors
//
// Writes src/data/games.candidate.json. Promoting it to games.json is a
// separate, reviewed step. A metadata cache at data/steam-meta.json (repo
// root, not src/data — kept out of the Next.js client bundle) lets stage 3
// skip appids it already has fresh data for, so a throttled run banks its
// completed work instead of starting over. That file IS committed to git:
// GitHub Actions checks out fresh every run, so an uncommitted cache means
// every scheduled run pays the full ~2-hour cold build and times out.
//
//   npm run data
import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  passesSentimentGate, passesCatalogueGate, parseSteamYear, bestGenre,
  modesFromCategories, capWithYearFloor, totalReviews, positivePct,
  BOARD_CAP, YEAR_FLOOR, type SteamSpyRow, type SteamDetail,
} from "../src/lib/steam-catalog";
import { cacheState, entryAgeMs, type SteamMetaCache } from "../src/lib/steam-cache";
import { steamSpyPage, appDetails, appReviews } from "./lib/steam-api";
import { rank, type Game } from "../src/lib/rank";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = join(ROOT, "src/data/games.json");
const OUT = join(ROOT, "src/data/games.candidate.json");
const CACHE_PATH = join(ROOT, "data/steam-meta.json"); // NOT src/data — never shipped to the client

const SPY_PAGES = 10;             // ~10,000 games by ownership
const SPY_SPACING_MS = 62_000;    // SteamSpy caps `all` at 1 request/minute
// appdetails and appreviews throttle independently and get separate pacing —
// named distinctly so nobody re-merges them. Steam appdetails 429s at 250ms
// (observed: ~200 req/5min, ~40/min); 1,600ms (~37/min) stays under that.
// appreviews was proven at 250ms/~700 calls by the old enricher and stage 6
// asks for ~1,000 — same order of magnitude, left alone.
const DETAIL_SPACING_MS = 1_600;
const REVIEWS_SPACING_MS = 250;
const BOARD_FLOOR = 0.8;          // refuse to write a board this much smaller than the live one

// Metadata cache: bounds stage 3's weekly cost and makes the (multi-attempt)
// first build resumable instead of all-or-nothing. The expiry rules live in
// src/lib/steam-cache.ts, where they are unit-tested.
// Bounds ONE thing only: re-fetching entries that ARE in the cache but have
// aged past their expiry. That keeps a steady-state weekly run doing a
// little maintenance rather than a lot.
//
// It deliberately does NOT bound appids absent from the cache — those are all
// fetched, every run, uncapped. Applying this cap to absent appids too (an easy
// mistake, since both populations "need a call") would make the first build
// fetch 300 of ~3,900 and need ~13 consecutive runs to warm up. The long first
// run is the intended trade; FAILURE_BUDGET below is what bounds a run that is
// actually going wrong.
const EXPIRED_REFRESH_CAP = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CURRENT_YEAR = new Date().getFullYear();
const round1 = (n: number) => Math.round(n * 10) / 10;

// A loop that catches-and-continues per item needs a tripwire: past this
// failure rate the upstream is refusing us outright, not just having a bad
// minute, and grinding through the rest just burns the pacing budget on
// results nobody should trust.
const FAILURE_BUDGET = 0.1;
const FAILURE_MIN_SAMPLE = 20; // don't trip the budget on a handful of early flukes

// Hard failures (429, 5xx, network, unparseable body) throw and land in
// FAILURE_BUDGET. A `null` return is the other, quieter failure mode: Steam
// answered HTTP 200 with `{"<appid>": {"success": false}}`, which it sends for
// delisted/region-locked apps AND for soft-throttled requests. Nulls are never
// cached (see steam-cache.ts), so a bad run costs only time — but it must still
// be loud, or a run where Steam says success:false to everything looks like a
// clean run that simply found nothing. Genuine delistings above the 2,000-review
// gate are a rounding error, so anything past 20% means Steam, not the catalogue.
const NULL_BUDGET = 0.2;

// Stage 3 runs for ~2 hours. Writing the cache only at the end means a Ctrl-C,
// crash or CI timeout banks nothing; every 100 calls bounds the loss instead.
const SAVE_EVERY = 100;

function loadCache(): SteamMetaCache {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as SteamMetaCache;
  } catch {
    return {}; // a corrupt cache just means everything looks "absent" this run
  }
}

// Atomic: a death mid-write must not leave truncated JSON behind, because
// loadCache() swallows a parse error and returns {} — which would silently
// discard hours of banked lookups. Temp file in the SAME directory so the
// rename stays within one filesystem and is therefore atomic.
function saveCache(cache: SteamMetaCache) {
  const dir = dirname(CACHE_PATH);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.steam-meta.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmp, CACHE_PATH);
}

// Probe both upstreams before a ~30-minute run, and name which one is down.
// They fail independently; conflating them is what made the RAWG outage
// ambiguous for weeks. SteamSpy's `all` endpoint is capped at 1 request per
// minute, so this page-0 probe IS stage 1's first page — it is returned to
// the caller and seeded into the map rather than fetched a second time,
// which would burn two requests inside the same 60-second window.
async function preflight(): Promise<SteamSpyRow[]> {
  let page0: SteamSpyRow[];
  try {
    page0 = await steamSpyPage(0);
  } catch (err) {
    console.error(`\nSteamSpy preflight failed: ${(err as Error).message}`);
    console.error("SteamSpy is a third-party service. Nothing is wrong with this repo.");
    console.error("If this persists for weeks, the discovery source needs replacing.");
    console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
    process.exit(75);
  }
  try {
    const d = await appDetails(1245620); // ELDEN RING
    if (!d) throw new Error("appdetails returned no data for a known-good appid");
  } catch (err) {
    console.error(`\nSteam preflight failed: ${(err as Error).message}`);
    console.error("Steam's store API is not answering. Nothing is wrong with this repo.");
    console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
    process.exit(75);
  }
  return page0;
}

async function main() {
  const page0 = await preflight();

  // --- 1. discover ---------------------------------------------------------
  // page0 came from the preflight probe above — re-requesting it here would
  // be a second call to a 1-request-per-minute endpoint within seconds.
  const candidates = new Map<number, SteamSpyRow>();
  for (const r of page0) candidates.set(r.appid, r);
  console.log(`  steamspy page 0: ${page0.length} rows (${candidates.size} unique)`);
  try {
    for (let page = 1; page < SPY_PAGES; page++) {
      await sleep(SPY_SPACING_MS);
      const rows = await steamSpyPage(page);
      for (const r of rows) candidates.set(r.appid, r);
      console.log(`  steamspy page ${page}: ${rows.length} rows (${candidates.size} unique)`);
    }
  } catch (err) {
    console.error(`\nSteamSpy discovery failed: ${(err as Error).message}`);
    console.error("SteamSpy is a third-party service. Nothing is wrong with this repo.");
    console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
    process.exit(75);
  }

  // --- 2. sentiment gate ---------------------------------------------------
  const gated = [...candidates.values()].filter(passesSentimentGate);
  console.log(`\nsentiment gate: ${gated.length}/${candidates.size} kept`);

  // --- 3 + 4. detail and catalogue gate ------------------------------------
  const cache = loadCache();
  const now = Date.now();

  // Two distinct populations, kept apart on purpose (see EXPIRED_REFRESH_CAP):
  //
  //   absent   no cache entry at all -> fetched, ALL of them, no cap
  //   expired  cached but past its expiry (180 days, or one week while the
  //            game is still coming soon) -> oldest-first, at most
  //            EXPIRED_REFRESH_CAP of them per run
  //
  // Do not re-merge these into one "needs a call" list with a single cap: that
  // starves the initial cache fill, which is the whole point of the cache.
  const cachedAgeMs = (appid: number): number | null => entryAgeMs(cache[String(appid)], now);
  const stateOf = (appid: number) => cacheState(cache[String(appid)], now);

  const absent = gated.filter((row) => stateOf(row.appid) === "absent");
  const expired = gated.filter((row) => stateOf(row.appid) === "expired");
  expired.sort((a, b) => cachedAgeMs(b.appid)! - cachedAgeMs(a.appid)!); // oldest first
  const refreshing = expired.slice(0, EXPIRED_REFRESH_CAP);
  const toFetch = new Set([...absent, ...refreshing].map((r) => r.appid));
  const fresh = gated.length - absent.length - expired.length;
  console.log(
    `\ndetail cache: ${fresh} fresh, ${absent.length} absent (all fetched), ` +
      `${expired.length} expired (${refreshing.length} refreshed this run) ` +
      `-> ${toFetch.size} appdetails calls`,
  );

  const kept: { row: SteamSpyRow; detail: SteamDetail; year: number }[] = [];
  let processed = 0;   // every gated row examined (cache hits + calls + still-absent)
  let attempted = 0;   // appdetails calls actually made this run
  let detailFailures = 0;
  let detailNulls = 0; // calls that returned success:false — never cached, only counted

  for (const row of gated) {
    const key = String(row.appid);
    let detail: SteamDetail | null;

    if (toFetch.has(row.appid)) {
      await sleep(DETAIL_SPACING_MS);
      try {
        detail = await appDetails(row.appid);
        // Only real details are banked. A null here is Steam's success:false,
        // which means "delisted" OR "throttled" and cannot be told apart —
        // caching it would mark a live game missing for 180 days, and no later
        // run could tell the poison from a real delisting.
        if (detail) cache[key] = { fetchedAt: new Date().toISOString(), detail };
        else detailNulls++;
      } catch (err) {
        console.warn(`  ${row.appid} detail failed — ${(err as Error).message}`);
        detail = null;
        detailFailures++; // no cache write — retried on a future run, not banked as "checked"
      }
      attempted++;
      if (attempted % SAVE_EVERY === 0) saveCache(cache); // resumable across a crash, not just a clean bail
      if (attempted >= FAILURE_MIN_SAMPLE && detailFailures / attempted > FAILURE_BUDGET) {
        console.error(`\nToo many appdetails failures: ${detailFailures}/${attempted} (>${FAILURE_BUDGET * 100}%).`);
        console.error("Steam's store API may be throttling or blocking this run.");
        saveCache(cache); // bank whatever this run did complete
        console.error(`Banked ${attempted - detailFailures - detailNulls} successful lookups to ${CACHE_PATH}.`);
        console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
        process.exit(75);
      }
      if (attempted >= FAILURE_MIN_SAMPLE && detailNulls / attempted > NULL_BUDGET) {
        console.error(`\nToo many appdetails "not found" replies: ${detailNulls}/${attempted} (>${NULL_BUDGET * 100}%).`);
        console.error("Steam appears to be answering success:false en masse — that is soft throttling,");
        console.error("not thousands of games being delisted at once. Nothing was cached for them.");
        saveCache(cache); // bank whatever this run did complete
        console.error(`Banked ${attempted - detailFailures - detailNulls} successful lookups to ${CACHE_PATH}.`);
        console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
        process.exit(75);
      }
    } else {
      // A fresh cache hit, or an expired entry past this run's refresh cap
      // (which still has usable, merely old, data) — either way, no network
      // call this iteration. Absent appids never land here: they are all in
      // `toFetch`.
      detail = cache[key]?.detail ?? null;
    }

    if (detail && passesCatalogueGate(detail, CURRENT_YEAR)) {
      kept.push({ row, detail, year: parseSteamYear(detail.releaseDate, detail.comingSoon)! });
    }
    ++processed;
    if (processed % 250 === 0) {
      console.log(
        `  detail ${processed}/${gated.length} (${kept.length} kept, ${attempted} fetched, ` +
          `${detailNulls} not found, ${detailFailures} failed)`,
      );
    }
  }

  saveCache(cache); // stage 3's completed work is banked whether or not later stages succeed
  console.log(
    `\ncatalogue gate: ${kept.length}/${gated.length} kept ` +
      `(${attempted} fresh calls, ${detailNulls} not found, ${detailFailures} failed)`,
  );

  // --- 5. rank and cap -----------------------------------------------------
  const provisional: Game[] = kept.map(({ row, detail, year }) => ({
    title: detail.name || row.name,
    year,
    developer: detail.developers[0] || row.developer || "—",
    genre: bestGenre(detail.genres),
    genreDetail: detail.genres.join(", ") || "—",
    platforms: ["PC"],
    metacritic: detail.metacritic,
    indie: detail.genres.some((g) => /indie/i.test(g)),
    modes: modesFromCategories(detail.categories),
    note: detail.shortDescription,
    steamAppId: row.appid,
    steamPositive: positivePct(row),
    steamReviews: totalReviews(row),
  })) as Game[];

  const scored = rank(provisional);
  const selected = capWithYearFloor(scored, BOARD_CAP, YEAR_FLOOR);
  console.log(`\ncap: ${selected.length} of ${scored.length} selected`);

  // --- 6. exact sentiment --------------------------------------------------
  const final: Game[] = [];
  let done = 0;
  let reviewFailures = 0;
  for (const g of selected) {
    await sleep(REVIEWS_SPACING_MS);
    let exact: { totalPositive: number; totalReviews: number } | null = null;
    try {
      exact = await appReviews(g.steamAppId!);
    } catch (err) {
      console.warn(`  ${g.steamAppId} reviews failed — ${(err as Error).message}`);
      reviewFailures++;
    }
    // Both fields must come from the same source: appreviews can succeed
    // with an empty summary (totalReviews 0), and steam-api.ts coerces a
    // missing total_reviews to 0 — so gating on `exact` alone would pair a
    // real, rounded steamPositive with a review count of 0, and playerSignal
    // treats a zero sample as no signal at all.
    const hasExact = exact != null && exact.totalReviews > 0;
    final.push({
      title: g.title, year: g.year, developer: g.developer, genre: g.genre,
      genreDetail: g.genreDetail, platforms: g.platforms, metacritic: g.metacritic,
      indie: g.indie, modes: g.modes, note: g.note, steamAppId: g.steamAppId,
      steamPositive: hasExact
        ? round1((exact!.totalPositive / exact!.totalReviews) * 100)
        : g.steamPositive == null ? g.steamPositive : round1(g.steamPositive),
      steamReviews: hasExact ? exact!.totalReviews : g.steamReviews,
    } as Game);
    ++done;
    if (done % 250 === 0) console.log(`  reviews ${done}/${selected.length}`);
    if (done >= FAILURE_MIN_SAMPLE && reviewFailures / done > FAILURE_BUDGET) {
      console.error(`\nToo many appreviews failures: ${reviewFailures}/${done} (>${FAILURE_BUDGET * 100}%).`);
      console.error("Steam's store API may be throttling or blocking this run — the rest of the board");
      console.error("would silently fall back to SteamSpy's approximate sentiment.");
      console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
      process.exit(75);
    }
  }

  // A partial run must never gut the board.
  if (existsSync(LIVE)) {
    const liveJson: unknown = JSON.parse(readFileSync(LIVE, "utf8"));
    // If the live file doesn't parse to an array, there's no count to compare
    // against — `undefined.length` would be NaN, and every `<` comparison
    // against NaN is false, so the floor would silently never trip.
    const liveCount = Array.isArray(liveJson) ? liveJson.length : 0;
    if (liveCount > 0 && final.length < liveCount * BOARD_FLOOR) {
      console.error(`\nOnly ${final.length} games, under ${Math.round(liveCount * BOARD_FLOOR)} (${BOARD_FLOOR * 100}% of the live ${liveCount}).`);
      console.error("Refusing to write. src/data/games.json is untouched.\n");
      process.exit(75);
    }
  }

  writeFileSync(OUT, JSON.stringify(final, null, 2) + "\n");

  const byYear: Record<number, number> = {};
  for (const g of final) byYear[g.year] = (byYear[g.year] ?? 0) + 1;
  console.log(`\nwrote ${OUT}`);
  console.log(`games: ${final.length}`);
  console.log(`by year: ${JSON.stringify(byYear)}`);
  console.log(`with metacritic: ${final.filter((g) => g.metacritic != null).length}`);
}

main().catch((err) => {
  console.error(`\nBuild failed: ${(err as Error).message}`);
  process.exit(1);
});
