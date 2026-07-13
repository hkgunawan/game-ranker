// Builds src/data/games.json fully automatically from the RAWG API — no curated
// docs. Discovers PC + PlayStation games released 2015→today via two passes:
//
//   A. critically acclaimed  — Metacritic 75–100
//   B. popular               — most-added titles, kept if the community rates
//                              them well with a real sample (filters shovelware)
//
// Then fetches each kept game's detail for developer, genres, tags (→ modes)
// and a short blurb. Steam player sentiment is layered on afterwards by
// scripts/enrich-steam.mjs.
//
// Needs a free RAWG key (rawg.io/apidocs — free, no card, 20k req/month):
//   RAWG_API_KEY=xxxx node scripts/fetch-rawg.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KEY = process.env.RAWG_API_KEY;
if (!KEY) {
  console.error("Missing RAWG_API_KEY. Get a free key at https://rawg.io/apidocs");
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/data/games.json");
const BASE = "https://api.rawg.io/api";

// RAWG platform ids: PC=4, PS5=187, PS4=18. We only surface PC + PlayStation.
const PC = 4;
const PS = [187, 18];
const PLATFORMS = [PC, ...PS].join(",");

const FROM_YEAR = 2015;
const TO_YEAR = 2026;
const DATES = `${FROM_YEAR}-01-01,${TO_YEAR}-12-31`;

// quality gates for the popularity pass (the critic pass is gated by metacritic)
const MIN_RATING = 3.8; // RAWG community rating, 0–5
const MIN_RATINGS_COUNT = 300; // real sample, not a handful of votes
const MAX_GAMES = 800; // cap detail calls / list size (richer per-year coverage)

// RAWG's `metacritic` field is barely populated for ~2023+ (e.g. Metaphor:
// ReFantazio, Alan Wake 2 all show null), so the acclaimed pass misses recent
// hits entirely. Cover recent years with a popularity/rating gate instead, and
// reserve enough slots that they aren't crowded out by the acclaimed back-catalog.
const RECENT_FROM = 2022; // RAWG metacritic coverage thins out from ~2022 on
const RECENT_MIN_RATING = 3.6;
const RECENT_MIN_RATINGS_COUNT = 40; // RAWG's user base is small; great niche games (Metaphor: 71) sit low
const RECENT_RESERVE = 320; // ~all qualifying 2022→today games

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, params = {}) {
  const u = new URL(`${BASE}/${path}`);
  u.searchParams.set("key", KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(u, { headers: { "User-Agent": "game-ranker data build" } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`RAWG ${res.status} on ${path}`);
  }
  throw new Error(`RAWG repeatedly failed on ${path}`);
}

// Walk a paginated list endpoint, yielding result rows up to `cap`.
async function* discover(params, cap) {
  let page = 1;
  let seen = 0;
  while (seen < cap) {
    const data = await api("games", { ...params, page, page_size: 40 });
    const results = data.results ?? [];
    if (!results.length) break;
    for (const r of results) {
      yield r;
      if (++seen >= cap) break;
    }
    if (!data.next) break;
    page++;
    await sleep(120);
  }
}

// --- genre canonicalization (same buckets the UI filter expects) ------------

const canonicalGenre = (raw) => {
  const t = (raw || "").toLowerCase();
  if (/soulslike/.test(t)) return "Soulslike";
  if (/fighting/.test(t)) return "Fighting";
  if (/racing|vehicular|sports/.test(t)) return "Racing & Sports";
  if (/massively|mmo|moba/.test(t)) return "MMO & Online";
  if (/metroidvania|platformer/.test(t)) return "Platformer & Metroidvania";
  if (/fps|shooter|run-and-gun|battle royale/.test(t)) return "Shooter & FPS";
  if (/horror/.test(t)) return "Horror";
  if (/strategy|4x|\brts\b/.test(t)) return "Strategy & 4X";
  if (/roguelike|rogue-like/.test(t)) return "Roguelike";
  if (/rpg|role-playing/.test(t)) return "RPG";
  if (/puzzle|exploration|mystery|point-and-click|educational/.test(t)) return "Puzzle & Exploration";
  if (/stealth/.test(t)) return "Stealth";
  if (/simulation|survival|sim|card|board/.test(t)) return "Survival & Sim";
  if (/narrative|visual novel|tactics|indie/.test(t)) return "Narrative & Tactics";
  if (/action|adventure|arcade|casual|family|western/.test(t)) return "Action & Adventure";
  return "Other";
};

// Pick the most specific genre bucket from RAWG's genre list (first match wins
// the canonicalGenre ordering, so test each and keep the earliest non-Other).
const ORDER = [
  "Soulslike", "Fighting", "Racing & Sports", "MMO & Online", "Platformer & Metroidvania",
  "Shooter & FPS", "Horror", "Strategy & 4X", "Roguelike", "RPG", "Puzzle & Exploration",
  "Stealth", "Survival & Sim", "Narrative & Tactics", "Action & Adventure", "Other",
];
function bestGenre(genreNames) {
  let best = "Other";
  let bestRank = ORDER.length;
  for (const name of genreNames) {
    const bucket = canonicalGenre(name);
    const r = ORDER.indexOf(bucket);
    if (r < bestRank) {
      bestRank = r;
      best = bucket;
    }
  }
  return best;
}

// derive play modes from RAWG tags
function modesFromTags(tagNames) {
  const t = tagNames.map((s) => s.toLowerCase());
  const has = (re) => t.some((x) => re.test(x));
  const out = [];
  if (has(/^singleplayer$|single player/)) out.push("Single-player");
  if (has(/co-?op/)) out.push("Co-op");
  if (has(/\bpvp\b|versus|competitive/)) out.push("PvP");
  if (has(/mmo|massively|online co-?op/)) out.push("Live-service");
  // sensible default: most games are at least single-player
  if (!out.includes("Single-player") && !has(/multiplayer/)) out.push("Single-player");
  return out.length ? [...new Set(out)] : ["Single-player"];
}

function platformsOf(platformList) {
  const ids = new Set((platformList ?? []).map((p) => p.platform?.id));
  const out = [];
  if (ids.has(PC)) out.push("PC");
  if (PS.some((id) => ids.has(id))) out.push("PlayStation");
  return out;
}

const yearOf = (released) => (released ? parseInt(released.slice(0, 4), 10) : null);
const TODAY = new Date().toISOString().slice(0, 10);
const trimNote = (s) => {
  if (!s) return "";
  const firstPara = s.split(/\n+/)[0].replace(/\s+/g, " ").trim();
  return firstPara.length > 220 ? firstPara.slice(0, 217).trimEnd() + "…" : firstPara;
};

// --- run --------------------------------------------------------------------

const bySlug = new Map();

function consider(r) {
  if (!r.slug || bySlug.has(r.slug)) return;
  const plats = platformsOf(r.platforms ?? r.parent_platforms);
  if (!plats.length) return;
  const year = yearOf(r.released);
  if (!year || year < FROM_YEAR || year > TO_YEAR) return;
  // Skip unreleased games — RAWG lists them (GTA VI, RE9, Pragmata) but they have
  // no real player verdict yet, and any Steam % they pick up is a wrong match.
  if (!r.released || (r.tba ?? false) || r.released > TODAY) return;
  bySlug.set(r.slug, { row: r, plats, year });
}

// Pass R — recent releases first, so the newest good games are guaranteed a
// place before the (much larger) acclaimed back-catalog fills the cap.
console.log(`RAWG pass R — recent releases (${RECENT_FROM}→${TO_YEAR})…`);
let rDropped = 0;
for await (const r of discover(
  { platforms: PLATFORMS, dates: `${RECENT_FROM}-01-01,${TO_YEAR}-12-31`, ordering: "-added" },
  RECENT_RESERVE * 6
)) {
  if (bySlug.has(r.slug)) continue;
  const goodEnough =
    r.metacritic != null ||
    ((r.rating ?? 0) >= RECENT_MIN_RATING && (r.ratings_count ?? 0) >= RECENT_MIN_RATINGS_COUNT);
  if (!goodEnough) {
    rDropped++;
    continue;
  }
  consider(r);
  if (bySlug.size >= RECENT_RESERVE) break;
}
console.log(`  recent candidates: ${bySlug.size} (dropped ${rDropped} low-quality)`);

console.log("RAWG pass A — critically acclaimed (Metacritic ≥ 75)…");
for await (const r of discover(
  { platforms: PLATFORMS, dates: DATES, metacritic: "75,100", ordering: "-metacritic" },
  MAX_GAMES
)) {
  consider(r);
  if (bySlug.size >= MAX_GAMES) break;
}
console.log(`  candidates so far: ${bySlug.size}`);

console.log("RAWG pass B — popular & well-rated…");
let bDropped = 0;
for await (const r of discover({ platforms: PLATFORMS, dates: DATES, ordering: "-added" }, MAX_GAMES * 2)) {
  if (bySlug.size >= MAX_GAMES) break;
  if (bySlug.has(r.slug)) continue;
  if ((r.rating ?? 0) < MIN_RATING || (r.ratings_count ?? 0) < MIN_RATINGS_COUNT) {
    bDropped++;
    continue;
  }
  consider(r);
}
console.log(`  candidates so far: ${bySlug.size} (dropped ${bDropped} low-quality)`);

console.log(`Fetching detail for ${bySlug.size} games…`);
const games = [];
let done = 0;
for (const { row, plats, year } of bySlug.values()) {
  let detail = null;
  try {
    detail = await api(`games/${row.id}`);
  } catch {
    /* fall back to list-level fields */
  }
  await sleep(110);

  const genreNames = (detail?.genres ?? row.genres ?? []).map((g) => g.name);
  const tagNames = (detail?.tags ?? row.tags ?? []).map((t) => t.name);
  const developer = (detail?.developers ?? [])[0]?.name || "—";

  games.push({
    title: row.name,
    year,
    developer,
    genre: bestGenre(genreNames),
    genreDetail: genreNames.join(", ") || "—",
    platforms: plats,
    metacritic: row.metacritic ?? detail?.metacritic ?? null,
    rawgRating: row.rating ?? detail?.rating ?? null,
    rawgRatingsCount: row.ratings_count ?? detail?.ratings_count ?? null,
    indie: genreNames.some((g) => /indie/i.test(g)),
    modes: modesFromTags(tagNames),
    note: trimNote(detail?.description_raw),
    rawgSlug: row.slug,
    steamAppId: null,
    steamPositive: null,
    steamReviews: null,
  });

  if (++done % 25 === 0) console.log(`  ${done}/${bySlug.size}`);
}

// RAWG sometimes lists the same game twice under different slugs — e.g. a base
// edition and a "Digital Deluxe Edition" SKU (Black Myth: Wukong / Wu Kong).
// The slug-based dedupe above misses these since the slugs differ. Catch them
// here by normalized title + year, keeping whichever listing has the larger
// community sample (the primary listing, not the edition variant).
const normTitle = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const byTitleYear = new Map();
for (const g of games) {
  const key = `${normTitle(g.title)}|${g.year}`;
  const existing = byTitleYear.get(key);
  if (!existing || (g.rawgRatingsCount ?? 0) > (existing.rawgRatingsCount ?? 0)) {
    byTitleYear.set(key, g);
  }
}
const deduped = [...byTitleYear.values()];
if (deduped.length < games.length) {
  console.log(`\ndeduped ${games.length - deduped.length} duplicate title/edition listing(s)`);
}

// stable, useful default order: metacritic then rawg rating
deduped.sort((a, b) => (b.metacritic ?? 0) - (a.metacritic ?? 0) || (b.rawgRating ?? 0) - (a.rawgRating ?? 0));

writeFileSync(OUT, JSON.stringify(deduped, null, 2) + "\n");

// --- stats ------------------------------------------------------------------

const both = deduped.filter((g) => g.platforms.length === 2).length;
const pcOnly = deduped.filter((g) => g.platforms.length === 1 && g.platforms[0] === "PC").length;
const psOnly = deduped.filter((g) => g.platforms.length === 1 && g.platforms[0] === "PlayStation").length;
const withMC = deduped.filter((g) => g.metacritic != null).length;
console.log(`\ngames:        ${deduped.length}`);
console.log(`  cross-plat: ${both}`);
console.log(`  PC only:    ${pcOnly}`);
console.log(`  PS only:    ${psOnly}`);
console.log(`with MC:      ${withMC}`);
console.log(`year range:   ${Math.min(...deduped.map((g) => g.year))}–${Math.max(...deduped.map((g) => g.year))}`);
console.log(`\nnext: node scripts/enrich-steam.mjs  (adds Steam player sentiment)`);
