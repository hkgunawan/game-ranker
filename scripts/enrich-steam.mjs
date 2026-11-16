// Enriches src/data/games.json with real Steam player sentiment:
//   steamAppId, steamPositive (% of reviews positive, 0–100), steamReviews (count)
//
// Keyless. Resolves each title via Steam's community app search, verifies the
// match by token overlap (to avoid grabbing the wrong app), then reads the
// public review summary. Titles not on Steam (true console exclusives) are left
// null and fall back to the editorial score at ranking time.
//
// Run:  node scripts/enrich-steam.mjs   (after `npm run data`)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "src/data/games.json");
const UA = { "User-Agent": "Mozilla/5.0 (game-ranker data build)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// roman → arabic so "Baldur's Gate III" matches "Baldur's Gate 3" (and the
// sequel-number guard below treats both forms the same)
const ROMAN = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };

const norm = (s) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents: ABZÛ → ABZU
    .toLowerCase()
    .replace(/[™®©:'’‘`´.,!?–—-]/g, " ")
    .replace(/\b(the|a|of|and|edition|definitive|complete|intergrade|directors|director|cut|goty|hd|version)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((t) => ROMAN[t] ?? t)
    .join(" ");

const tokens = (s) => new Set(norm(s).split(" ").filter(Boolean));
const jaccard = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};

// `redirect: "manual"` is deliberate. Steam retires endpoints by 302-ing them to
// the store home page; following that redirect yields a 200 full of HTML, which
// used to surface as a cryptic JSON parse error on every single title.
async function getJson(url) {
  const res = await fetch(url, { headers: UA, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`HTTP ${res.status} redirect — endpoint moved or retired`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error(`expected JSON, got ${type || "no content-type"}`);
  return res.json();
}

// Extra *sequel-number* tokens in `name` not in `query` signal a wrong
// base-vs-sequel match (e.g. "Spider-Man" → "Spider-Man 2"). Edition words
// like remake/remastered usually denote the canonical Steam release of the
// SAME game, so they are NOT penalized.
// roman numerals are converted to arabic by norm(), so only guard arabic here
const SEQUEL_NUM = /^(2|3|4|5|6|7|8|9|10)$/;
function matchScore(query, name) {
  if (norm(query) === norm(name)) return 2; // exact normalized match wins outright
  let score = jaccard(query, name);
  const q = tokens(query);
  const n = tokens(name);
  // a sequel/version numeral on one side but not the other = wrong entry
  // ("Spider-Man" → "Spider-Man 2", or "GTA VI" → "GTA San Andreas")
  for (const t of n) if (!q.has(t) && SEQUEL_NUM.test(t)) score -= 0.6;
  for (const t of q) if (!n.has(t) && SEQUEL_NUM.test(t)) score -= 0.6;
  return score;
}

// drop parentheticals/edition noise that breaks Steam search ("DOOM (2016)")
const searchTerm = (title) =>
  title.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

async function searchBest(query) {
  const results = await getJson(`https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(query)}`);
  if (!Array.isArray(results) || results.length === 0) return null;
  let best = null;
  for (const r of results.slice(0, 8)) {
    const score = matchScore(query, r.name);
    if (!best || score > best.score) best = { appid: r.appid, name: r.name, score };
  }
  return best;
}

// Verified appids for titles the fuzzy search misses or mis-ranks (base-vs-sequel,
// edition naming). Confirmed by hand against the Steam store.
const OVERRIDES = {
  "Marvel's Spider-Man": 1817070, // Remastered (search grabs Miles Morales)
  "Dead Space Remake": 1693980, // listed as "Dead Space"
  "Overwatch 2": 2357570, // listed as "Overwatch®"
  "Uncharted 4: A Thief's End": 1659420, // Legacy of Thieves Collection
};
// match overrides by normalized title so curly apostrophes / accents still hit
const OVERRIDE_BY_NORM = new Map(Object.entries(OVERRIDES).map(([k, v]) => [norm(k), v]));

// Below this we don't trust the match — leave Steam null and fall back to the
// RAWG community rating. Better no Steam data than wrong Steam data (e.g.
// "GTA VI" grabbing San Andreas, or a console exclusive grabbing a soundalike).
const STRONG = 0.5;

async function resolve(title) {
  const ov = OVERRIDE_BY_NORM.get(norm(title));
  if (ov) return { appid: ov, name: "(verified override)", score: 2 };
  const candidates = [searchTerm(title)];
  const preColon = searchTerm(title.split(":")[0]); // fallback: drop subtitle
  if (preColon && preColon !== candidates[0]) candidates.push(preColon);
  let best = null;
  for (const q of candidates) {
    const r = await searchBest(q);
    if (r && (!best || r.score > best.score)) best = r;
    if (best && best.score >= STRONG) break; // good enough, stop
  }
  if (!best || best.score < STRONG) return null; // reject weak — fall back to RAWG
  return best;
}

// Review summaries come from Steam's official Web API (keyless), many apps per
// call. The old per-app store endpoint (/appreviews/<id>?json=1) was retired in
// Oct 2026 — it now 302s to the store home page — which silently emptied Steam
// data for the whole dataset. Batching also cuts ~800 requests down to ~16.
const BATCH = 50;
async function reviewsFor(appids) {
  const out = new Map();
  for (let i = 0; i < appids.length; i += BATCH) {
    const input = {
      ids: appids.slice(i, i + BATCH).map((appid) => ({ appid })),
      context: { language: "english", country_code: "US" },
      data_request: { include_reviews: true },
    };
    const d = await getJson(
      `https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`
    );
    for (const item of d.response?.store_items ?? []) {
      const r = item.reviews?.summary_filtered;
      if (item.success !== 1 || !r?.review_count) continue;
      out.set(Number(item.appid), { positive: r.percent_positive, reviews: r.review_count });
    }
    await sleep(500);
  }
  return out;
}

const games = JSON.parse(readFileSync(FILE, "utf8"));
let matched = 0, missing = 0, errors = 0;
const report = [];

// Pass 1: resolve each title to a Steam appid.
const resolved = new Map(); // game -> { appid, name }
for (const g of games) {
  g.steamAppId = null;
  g.steamPositive = null;
  g.steamReviews = null;
  try {
    const m = await resolve(g.title);
    await sleep(120);
    if (!m || m.appid == null) {
      missing++;
      report.push(`  ✗ ${g.title} — not found`);
      continue;
    }
    resolved.set(g, { appid: Number(m.appid), name: m.name });
  } catch (e) {
    missing++;
    errors++;
    report.push(`  ✗ ${g.title} — error ${e.message}`);
  }
}

// Pass 2: review summaries for every resolved appid, in batches.
let summaries = new Map();
try {
  summaries = await reviewsFor([...new Set([...resolved.values()].map((m) => m.appid))]);
} catch (e) {
  errors += resolved.size;
  report.push(`  ✗ review lookup failed — ${e.message}`);
}

for (const [g, m] of resolved) {
  const rv = summaries.get(m.appid);
  if (!rv) {
    missing++;
    report.push(`  ✗ ${g.title} — no reviews [${m.name}]`);
    continue;
  }
  g.steamAppId = m.appid;
  g.steamPositive = rv.positive;
  g.steamReviews = rv.reviews;
  matched++;
  report.push(`  ✓ ${g.title} → ${m.name} [${m.appid}] ${rv.positive}% (${rv.reviews.toLocaleString()})`);
}

console.log(report.join("\n"));
console.log(`\nmatched: ${matched} · missing: ${missing} · errors: ${errors}`);

// Fail loudly instead of committing a hollowed-out dataset. Healthy runs match
// ~85% of titles; when Steam changes something the rate collapses, and before
// this guard the workflow happily committed 0/798 for weeks while reporting
// success. A non-zero exit stops the commit step, so the site keeps the last
// good data and the workflow raises its alert issue.
const MIN_MATCH_RATE = 0.6;
const rate = games.length ? matched / games.length : 0;
if (rate < MIN_MATCH_RATE) {
  console.error(
    `\nSteam enrichment matched only ${(rate * 100).toFixed(0)}% of ${games.length} games ` +
      `(need ${MIN_MATCH_RATE * 100}%). Not writing the dataset — check the errors above; ` +
      `a Steam endpoint has probably changed.`
  );
  process.exit(1);
}

writeFileSync(FILE, JSON.stringify(games, null, 2) + "\n");
