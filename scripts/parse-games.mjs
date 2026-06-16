// Parses the two curated markdown ranking docs into one unified dataset.
//   PC  (data-sources/pc_games.md)  — 7-axis /100 scores, Parts 1/2/4 are canonical
//   PS5 (data-sources/ps5_games.md) — 6-axis /100 scores, 4 tier tables
//
// Rule for "is this a ranked row?": the table's first header column is "#".
// That alone excludes axis tables, tier keys, the dead-SEA table, appendices, etc.
// For the PC file we additionally drop Parts 3 & 5 — the doc states they are
// re-listings of the same titles under a different lens, not new entries.
//
// Run:  node scripts/parse-games.mjs   ->  writes src/data/games.json
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- cell helpers -----------------------------------------------------------

const cleanTitle = (raw) =>
  raw
    .replace(/\*\*/g, "")
    .replace(/[🔄♾️◆🧍🤝⚔️🌐💬⚠️]/gu, "")
    .replace(/️/g, "")
    .split(/\s+\+\s+/)[0] // drop "+ DLC" tails
    .replace(/\*\([^)]*\)\*/g, "") // drop *(Edition)* italic parentheticals
    .replace(/\s*—.*$/, "") // drop "— subtitle" tails
    .trim();

const normKey = (title) =>
  title
    .toLowerCase()
    .replace(/\([^)]*\)/g, "") // drop (parentheticals)
    .replace(/[:'.,!]/g, "")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

// The two source docs use 72 inconsistent free-text genre strings (e.g.
// "Action-adventure" vs "Action-Adventure", "Co-op shooter" vs "Co-op Shooter").
// Collapse them into a small set of canonical buckets so the genre filter is
// usable. Each game has exactly one genre; first matching rule wins (order matters).
const canonicalGenre = (raw) => {
  const t = raw.toLowerCase();
  if (/soulslike/.test(t)) return "Soulslike";
  if (/fighting/.test(t)) return "Fighting";
  if (/racing|vehicular|sports/.test(t)) return "Racing & Sports";
  if (/mmo|moba/.test(t)) return "MMO & Online";
  if (/metroidvania|platformer/.test(t)) return "Platformer & Metroidvania";
  if (/fps|shooter|run-and-gun|battle royale/.test(t)) return "Shooter & FPS";
  if (/horror/.test(t)) return "Horror";
  if (/strategy|4x|\brts\b/.test(t)) return "Strategy & 4X";
  if (/roguelike/.test(t)) return "Roguelike";
  if (/rpg/.test(t)) return "RPG";
  if (/puzzle|exploration|mystery/.test(t)) return "Puzzle & Exploration";
  if (/stealth/.test(t)) return "Stealth";
  if (/factory|survival|space exploration|creature/.test(t)) return "Survival & Sim";
  if (/narrative|visual novel|tactics/.test(t)) return "Narrative & Tactics";
  if (/action|adventure|traversal|immersive|western/.test(t)) return "Action & Adventure";
  return "Other";
};

const firstYear = (s) => {
  const m = s.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
};

const scoreOf = (s) => {
  const m = s.replace(/\*/g, "").match(/\d{2,3}/);
  return m ? parseInt(m[0], 10) : null;
};

const MODE_EMOJI = { "🧍": "Single-player", "🤝": "Co-op", "⚔️": "PvP", "🌐": "Live-service" };
const modesFromEmoji = (s) => {
  const out = [];
  for (const [e, label] of Object.entries(MODE_EMOJI)) if (s.includes(e)) out.push(label);
  return out;
};
const modesFromGenre = (g) => {
  const t = g.toLowerCase();
  const out = [];
  if (/co-?op/.test(t)) out.push("Co-op");
  if (/fighting|pvp|competitive|shooter|racing|sports/.test(t)) out.push("PvP");
  if (/live|mmo|moba|service/.test(t)) out.push("Live-service");
  if (out.length === 0 || /rpg|adventure|horror|platformer|narrative|strategy|soulslike|action/.test(t))
    out.push("Single-player");
  return [...new Set(out)];
};

// --- table walker -----------------------------------------------------------

// Splits a markdown table row "| a | b |" into trimmed cells.
const cells = (line) =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

const isSep = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);

// Walk a file's lines, yielding { headers, rows } for every table whose first
// header cell is "#". `onHeading(line)` lets the caller track section context.
function* tables(text, onHeading = () => {}) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) onHeading(line);
    if (!line.trim().startsWith("|")) continue;
    // potential header: next line is a separator row
    if (i + 1 < lines.length && isSep(lines[i + 1])) {
      const headers = cells(line);
      if (headers[0] !== "#") {
        i++; // skip the separator, keep scanning
        continue;
      }
      const rows = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
        if (isSep(lines[j])) continue;
        rows.push(cells(lines[j]));
      }
      yield { headers, rows };
      i = j - 1;
    }
  }
}

const colIndex = (headers, ...names) => {
  for (const name of names) {
    const idx = headers.findIndex((h) => h.toLowerCase().includes(name));
    if (idx !== -1) return idx;
  }
  return -1;
};

// --- merge ------------------------------------------------------------------

const byKey = new Map();

function upsert(rec) {
  const key = normKey(rec.title);
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, rec);
    return;
  }
  // merge cross-platform / cross-section duplicate
  existing.platforms = [...new Set([...existing.platforms, ...rec.platforms])];
  if (rec.pcScore != null) existing.pcScore = rec.pcScore;
  if (rec.psScore != null) existing.psScore = rec.psScore;
  if (rec.metacritic != null && existing.metacritic == null) existing.metacritic = rec.metacritic;
  if (rec.awards?.length) existing.awards = [...new Set([...(existing.awards ?? []), ...rec.awards])];
  if (rec.note && (!existing.note || rec.note.length > existing.note.length)) existing.note = rec.note;
  existing.indie = existing.indie || rec.indie;
  existing.modes = [...new Set([...(existing.modes ?? []), ...(rec.modes ?? [])])];
  if (!existing.genre && rec.genre) existing.genre = rec.genre;
  if (!existing.developer && rec.developer) existing.developer = rec.developer;
  if (rec.year && (!existing.year || rec.year < existing.year)) existing.year = rec.year;
}

// --- awards / metacritic extraction (from PS "why" notes) -------------------

function extractAwards(note) {
  const out = [];
  const goty = note.match(/\b(TGA|BAFTA|Hugo)\b[^;.]*GOTY[^;.]*/gi) || [];
  out.push(...goty.map((s) => s.trim().replace(/\s+/g, " ")));
  if (/Players'? Voice/i.test(note)) out.push("TGA Players' Voice");
  if (/Best Fighting Game/i.test(note)) out.push("TGA Best Fighting Game");
  return [...new Set(out)];
}
const extractMC = (note) => {
  const m = note.match(/\b(\d{2,3})\s*(?:MC|OC)\b/);
  return m ? parseInt(m[1], 10) : null;
};

// --- PC file ----------------------------------------------------------------

const pcText = readFileSync(join(ROOT, "data-sources/pc_games.md"), "utf8");
let pcPart = 0;
const pcOnHeading = (line) => {
  const m = line.match(/^#\s.*PART\s+(\d)/i);
  if (m) pcPart = parseInt(m[1], 10);
};
for (const { headers, rows } of tables(pcText, pcOnHeading)) {
  if (![1, 2, 4].includes(pcPart)) continue; // skip Parts 3 & 5 re-listings + pre-Part front matter
  const ci = {
    game: colIndex(headers, "game"),
    year: colIndex(headers, "year"),
    dev: colIndex(headers, "developer", "dev"),
    genre: colIndex(headers, "genre"),
    mode: colIndex(headers, "mode"),
    score: colIndex(headers, "score"),
    indie: headers.findIndex((h) => h.trim() === "◆"),
  };
  for (const r of rows) {
    const rawGame = r[ci.game] ?? "";
    const title = cleanTitle(rawGame);
    const score = ci.score >= 0 ? scoreOf(r[ci.score]) : null;
    if (!title || score == null) continue;
    upsert({
      title,
      year: ci.year >= 0 ? firstYear(r[ci.year]) : null,
      developer: ci.dev >= 0 ? r[ci.dev] : "",
      genre: ci.genre >= 0 ? r[ci.genre] : "",
      platforms: ["PC"],
      pcScore: score,
      psScore: null,
      metacritic: null,
      awards: [],
      indie: pcPart === 4 || /◆/.test(rawGame) || (ci.indie >= 0 && r[ci.indie] === "◆"),
      modes: ci.mode >= 0 ? modesFromEmoji(r[ci.mode]) : [],
      note: "",
    });
  }
}

// --- PS5 file ---------------------------------------------------------------

const psText = readFileSync(join(ROOT, "data-sources/ps5_games.md"), "utf8");
for (const { headers, rows } of tables(psText)) {
  const ci = {
    game: colIndex(headers, "game"),
    year: colIndex(headers, "year"),
    dev: colIndex(headers, "developer", "dev"),
    genre: colIndex(headers, "genre"),
    score: colIndex(headers, "score"),
    why: colIndex(headers, "why"),
  };
  for (const r of rows) {
    const title = cleanTitle(r[ci.game] ?? "");
    const score = ci.score >= 0 ? scoreOf(r[ci.score]) : null;
    if (!title || score == null) continue;
    const note = ci.why >= 0 ? r[ci.why] : "";
    const genre = ci.genre >= 0 ? r[ci.genre] : "";
    upsert({
      title,
      year: ci.year >= 0 ? firstYear(r[ci.year]) : null,
      developer: ci.dev >= 0 ? r[ci.dev] : "",
      genre,
      platforms: ["PlayStation"],
      pcScore: null,
      psScore: score,
      metacritic: extractMC(note),
      awards: extractAwards(note),
      indie: false,
      modes: modesFromGenre(genre),
      note,
    });
  }
}

// --- finalize ---------------------------------------------------------------

const games = [...byKey.values()]
  .filter((g) => g.year != null)
  .map((g) => ({
    ...g,
    developer: g.developer || "—",
    genreDetail: g.genre || "—", // original wording, shown in the per-game detail
    genre: canonicalGenre(g.genre || ""), // canonical bucket, used by the table + filter
    modes: g.modes.length ? g.modes : ["Single-player"],
  }));

writeFileSync(join(ROOT, "src/data/games.json"), JSON.stringify(games, null, 2) + "\n");

// --- stats ------------------------------------------------------------------

const both = games.filter((g) => g.platforms.length === 2).length;
const pcOnly = games.filter((g) => g.platforms.length === 1 && g.platforms[0] === "PC").length;
const psOnly = games.filter((g) => g.platforms.length === 1 && g.platforms[0] === "PlayStation").length;
const years = games.map((g) => g.year);
const scores = games.map((g) => (g.pcScore ?? 0 + g.psScore ?? 0, [g.pcScore, g.psScore].filter((s) => s != null)));
const flat = scores.flat();
console.log(`games:        ${games.length}`);
console.log(`  cross-plat: ${both}`);
console.log(`  PC only:    ${pcOnly}`);
console.log(`  PS only:    ${psOnly}`);
console.log(`year range:   ${Math.min(...years)}–${Math.max(...years)}`);
console.log(`mean score:   ${(flat.reduce((a, b) => a + b, 0) / flat.length).toFixed(2)}`);
console.log(`with MC:      ${games.filter((g) => g.metacritic != null).length}`);
console.log(`with awards:  ${games.filter((g) => g.awards.length).length}`);
console.log(`indie:        ${games.filter((g) => g.indie).length}`);
console.log(`\nsample cross-platform:`);
for (const g of games.filter((x) => x.platforms.length === 2).slice(0, 8))
  console.log(`  ${g.title} — PC ${g.pcScore} / PS ${g.psScore}${g.metacritic ? " / MC " + g.metacritic : ""}`);
