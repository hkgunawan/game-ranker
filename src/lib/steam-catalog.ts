// Decision logic for building the board from Steam data. Pure — no network,
// no filesystem — so every rule here is unit-tested.

export interface SteamSpyRow {
  appid: number;
  name: string;
  developer: string;
  positive: number;
  negative: number;
}

export interface SteamDetail {
  type: string;
  name: string;
  releaseDate: string;
  comingSoon: boolean;
  genres: string[];
  categories: string[];
  developers: string[];
  shortDescription: string;
  metacritic: number | null;
}

export const MIN_REVIEWS = 2_000;      // "real sentiment" — typically 2-6 weeks post-launch
export const MIN_POSITIVE_PCT = 75;
export const FROM_YEAR = 2015;
export const BOARD_CAP = 1_000;        // ~524 bytes/game; the whole board ships to the client
export const YEAR_FLOOR = 40;

export const totalReviews = (r: SteamSpyRow): number => r.positive + r.negative;

export function positivePct(r: SteamSpyRow): number {
  const n = totalReviews(r);
  return n === 0 ? 0 : (r.positive / n) * 100;
}

export function passesSentimentGate(r: SteamSpyRow): boolean {
  return totalReviews(r) >= MIN_REVIEWS && positivePct(r) >= MIN_POSITIVE_PCT;
}

// Steam's US-English release_date.date is "Mon DD, YYYY"; some older or odd
// entries carry a bare year. Everything else ("Q1 2026", "Coming soon", "To be
// announced") is refused rather than guessed — inventing a year for unreleased
// titles is how GTA VI-shaped entries reached the old board.
const EXACT_DATE = /^[A-Z][a-z]{2} \d{1,2}, (\d{4})$/;
const BARE_YEAR = /^(\d{4})$/;

export function parseSteamYear(date: string, comingSoon: boolean): number | null {
  if (comingSoon) return null;
  const m = EXACT_DATE.exec(date.trim()) ?? BARE_YEAR.exec(date.trim());
  return m ? Number(m[1]) : null;
}

export function passesCatalogueGate(d: SteamDetail, currentYear: number): boolean {
  if (d.type !== "game") return false;
  const year = parseSteamYear(d.releaseDate, d.comingSoon);
  if (year == null) return false;
  return year >= FROM_YEAR && year <= currentYear;
}

const canonicalGenre = (raw: string): string => {
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

const ORDER = [
  "Soulslike", "Fighting", "Racing & Sports", "MMO & Online", "Platformer & Metroidvania",
  "Shooter & FPS", "Horror", "Strategy & 4X", "Roguelike", "RPG", "Puzzle & Exploration",
  "Stealth", "Survival & Sim", "Narrative & Tactics", "Action & Adventure", "Other",
];

export function bestGenre(genreNames: string[]): string {
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

// Steam "categories" are feature flags (Single-player, Online Co-op, MMO, ...).
export function modesFromCategories(categories: string[]): string[] {
  const t = categories.map((s) => s.toLowerCase());
  const has = (re: RegExp) => t.some((x) => re.test(x));
  const out: string[] = [];
  if (has(/single-?player/)) out.push("Single-player");
  if (has(/co-?op/)) out.push("Co-op");
  if (has(/pvp/)) out.push("PvP");
  if (has(/mmo|massively/)) out.push("Live-service");
  return out.length ? [...new Set(out)] : ["Single-player"];
}

// Take the best `cap` games by score, but reserve `floor` slots per release year
// first. Ranking purely by score would let a strong back-catalogue year squeeze
// the current year off the board — which is exactly what the RAWG pipeline did.
export function capWithYearFloor<T extends { year: number; composite: number }>(
  games: T[],
  cap: number,
  floor: number
): T[] {
  const sorted = [...games].sort((a, b) => b.composite - a.composite);
  const byYear = new Map<number, T[]>();
  for (const g of sorted) {
    const list = byYear.get(g.year);
    if (list) list.push(g);
    else byYear.set(g.year, [g]);
  }
  if (floor * byYear.size > cap) {
    throw new Error(`floor ${floor} across ${byYear.size} years exceeds cap ${cap}`);
  }
  const picked = new Set<T>();
  for (const list of byYear.values()) for (const g of list.slice(0, floor)) picked.add(g);
  for (const g of sorted) {
    if (picked.size >= cap) break;
    picked.add(g);
  }
  return [...picked].sort((a, b) => b.composite - a.composite);
}
