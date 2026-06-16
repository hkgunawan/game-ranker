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

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[™®©:'.,!?-]/g, " ")
    .replace(/\b(the|a|of|and|edition|definitive|complete|intergrade|directors|director|cut|goty)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (s) => new Set(norm(s).split(" ").filter(Boolean));
const jaccard = (a, b) => {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};

async function getJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Extra *sequel-number* tokens in `name` not in `query` signal a wrong
// base-vs-sequel match (e.g. "Spider-Man" → "Spider-Man 2"). Edition words
// like remake/remastered usually denote the canonical Steam release of the
// SAME game, so they are NOT penalized.
const SEQUEL_NUM = /^(2|3|4|5|6|7|8|ii|iii|iv|v|vi|vii|viii)$/;
function matchScore(query, name) {
  if (norm(query) === norm(name)) return 2; // exact normalized match wins outright
  let score = jaccard(query, name);
  const q = tokens(query);
  for (const t of tokens(name)) if (!q.has(t) && SEQUEL_NUM.test(t)) score -= 0.6;
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

async function resolve(title) {
  if (OVERRIDES[title]) return { appid: OVERRIDES[title], name: "(verified override)", score: 2 };
  const candidates = [searchTerm(title)];
  const preColon = searchTerm(title.split(":")[0]); // fallback: drop subtitle
  if (preColon && preColon !== candidates[0]) candidates.push(preColon);
  let best = null;
  for (const q of candidates) {
    const r = await searchBest(q);
    if (r && (!best || r.score > best.score)) best = r;
    if (best && best.score >= 0.5) break; // good enough, stop
  }
  if (!best) return null;
  return best.score >= 0.34 ? best : { ...best, weak: true };
}

async function reviews(appid) {
  const d = await getJson(
    `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`
  );
  const q = d.query_summary ?? {};
  const tot = q.total_reviews ?? 0;
  if (!tot) return null;
  return { positive: Math.round((1000 * q.total_positive) / tot) / 10, reviews: tot, desc: q.review_score_desc ?? "" };
}

const games = JSON.parse(readFileSync(FILE, "utf8"));
let matched = 0, missing = 0, weak = 0;
const report = [];

for (const g of games) {
  g.steamAppId = null;
  g.steamPositive = null;
  g.steamReviews = null;
  try {
    const m = await resolve(g.title);
    if (!m || m.appid == null) {
      missing++;
      report.push(`  ✗ ${g.title} — not found`);
      continue;
    }
    if (m.weak) weak++;
    const rv = await reviews(m.appid);
    await sleep(250);
    if (!rv) {
      missing++;
      report.push(`  ✗ ${g.title} — no reviews [${m.name}]`);
      continue;
    }
    g.steamAppId = m.appid;
    g.steamPositive = rv.positive;
    g.steamReviews = rv.reviews;
    matched++;
    const flag = m.weak ? " ⚠ weak-match" : "";
    report.push(`  ✓ ${g.title} → ${m.name} [${m.appid}] ${rv.positive}% (${rv.reviews.toLocaleString()})${flag}`);
  } catch (e) {
    missing++;
    report.push(`  ✗ ${g.title} — error ${e.message}`);
  }
}

writeFileSync(FILE, JSON.stringify(games, null, 2) + "\n");
console.log(report.join("\n"));
console.log(`\nmatched: ${matched} · missing: ${missing} · weak matches (review these): ${weak}`);
