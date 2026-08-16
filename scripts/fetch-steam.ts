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

// Probe both upstreams before a ~30-minute run, and name which one is down.
// They fail independently; conflating them is what made the RAWG outage
// ambiguous for weeks.
async function preflight() {
  try {
    await steamSpyPage(0);
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
}

async function main() {
  await preflight();

  // --- 1. discover ---------------------------------------------------------
  const candidates = new Map<number, SteamSpyRow>();
  for (let page = 0; page < SPY_PAGES; page++) {
    if (page > 0) await sleep(SPY_SPACING_MS);
    const rows = await steamSpyPage(page);
    for (const r of rows) candidates.set(r.appid, r);
    console.log(`  steamspy page ${page}: ${rows.length} rows (${candidates.size} unique)`);
  }

  // --- 2. sentiment gate ---------------------------------------------------
  const gated = [...candidates.values()].filter(passesSentimentGate);
  console.log(`\nsentiment gate: ${gated.length}/${candidates.size} kept`);

  // --- 3 + 4. detail and catalogue gate ------------------------------------
  const kept: { row: SteamSpyRow; detail: SteamDetail; year: number }[] = [];
  let done = 0;
  for (const row of gated) {
    await sleep(STEAM_SPACING_MS);
    let detail: SteamDetail | null = null;
    try {
      detail = await appDetails(row.appid);
    } catch (err) {
      console.warn(`  ${row.appid} detail failed — ${(err as Error).message}`);
    }
    if (detail && passesCatalogueGate(detail, CURRENT_YEAR)) {
      kept.push({ row, detail, year: parseSteamYear(detail.releaseDate, detail.comingSoon)! });
    }
    if (++done % 250 === 0) console.log(`  detail ${done}/${gated.length} (${kept.length} kept)`);
  }
  console.log(`\ncatalogue gate: ${kept.length}/${gated.length} kept`);

  // --- 5. rank and cap -----------------------------------------------------
  const provisional: Game[] = kept.map(({ row, detail, year }) => ({
    title: detail.name || row.name,
    year,
    developer: detail.developers[0] ?? row.developer ?? "—",
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
  for (const g of selected) {
    await sleep(STEAM_SPACING_MS);
    let exact: { totalPositive: number; totalReviews: number } | null = null;
    try {
      exact = await appReviews(g.steamAppId!);
    } catch (err) {
      console.warn(`  ${g.steamAppId} reviews failed — ${(err as Error).message}`);
    }
    final.push({
      title: g.title, year: g.year, developer: g.developer, genre: g.genre,
      genreDetail: g.genreDetail, platforms: g.platforms, metacritic: g.metacritic,
      indie: g.indie, modes: g.modes, note: g.note, steamAppId: g.steamAppId,
      steamPositive: exact && exact.totalReviews > 0
        ? (exact.totalPositive / exact.totalReviews) * 100
        : g.steamPositive,
      steamReviews: exact?.totalReviews ?? g.steamReviews,
    } as Game);
    if (++done % 250 === 0) console.log(`  reviews ${done}/${selected.length}`);
  }

  // A partial run must never gut the board.
  if (existsSync(LIVE)) {
    const liveCount = (JSON.parse(readFileSync(LIVE, "utf8")) as unknown[]).length;
    if (final.length < liveCount * BOARD_FLOOR) {
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
