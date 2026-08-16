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
// separate, reviewed step.
//
//   npm run data
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  passesSentimentGate, passesCatalogueGate, parseSteamYear, bestGenre,
  modesFromCategories, capWithYearFloor, totalReviews, positivePct,
  BOARD_CAP, YEAR_FLOOR, type SteamSpyRow, type SteamDetail,
} from "../src/lib/steam-catalog";
import { steamSpyPage, appDetails, appReviews } from "./lib/steam-api";
import { rank, type Game } from "../src/lib/rank";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = join(ROOT, "src/data/games.json");
const OUT = join(ROOT, "src/data/games.candidate.json");

const SPY_PAGES = 10;            // ~10,000 games by ownership
const SPY_SPACING_MS = 62_000;   // SteamSpy caps `all` at 1 request/minute
const STEAM_SPACING_MS = 250;    // proven in production by the old enricher
const BOARD_FLOOR = 0.8;         // refuse to write a board this much smaller than the live one

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CURRENT_YEAR = new Date().getFullYear();
const round1 = (n: number) => Math.round(n * 10) / 10;

// A loop that catches-and-continues per item needs a tripwire: past this
// failure rate the upstream is refusing us outright, not just having a bad
// minute, and grinding through the rest just burns the pacing budget on
// results nobody should trust.
const FAILURE_BUDGET = 0.1;
const FAILURE_MIN_SAMPLE = 20; // don't trip the budget on a handful of early flukes

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
  const kept: { row: SteamSpyRow; detail: SteamDetail; year: number }[] = [];
  let done = 0;
  let detailFailures = 0;
  for (const row of gated) {
    await sleep(STEAM_SPACING_MS);
    let detail: SteamDetail | null = null;
    try {
      detail = await appDetails(row.appid);
    } catch (err) {
      console.warn(`  ${row.appid} detail failed — ${(err as Error).message}`);
      detailFailures++;
    }
    if (detail && passesCatalogueGate(detail, CURRENT_YEAR)) {
      kept.push({ row, detail, year: parseSteamYear(detail.releaseDate, detail.comingSoon)! });
    }
    ++done;
    if (done % 250 === 0) console.log(`  detail ${done}/${gated.length} (${kept.length} kept)`);
    if (done >= FAILURE_MIN_SAMPLE && detailFailures / done > FAILURE_BUDGET) {
      console.error(`\nToo many appdetails failures: ${detailFailures}/${done} (>${FAILURE_BUDGET * 100}%).`);
      console.error("Steam's store API may be throttling or blocking this run.");
      console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
      process.exit(75);
    }
  }
  console.log(`\ncatalogue gate: ${kept.length}/${gated.length} kept`);

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
  done = 0;
  let reviewFailures = 0;
  for (const g of selected) {
    await sleep(STEAM_SPACING_MS);
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
