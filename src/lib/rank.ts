// The ranking algorithm.
//
// Each game has an editorial score (the curated /100 docs — critic-anchored) and,
// where available, real player sentiment from Steam (% of reviews positive). The
// composite blends the two, and the critic↔player balance is a live, tunable knob.
//
//   composite = editorial·(1 − w′) + players%·w′
//
//   w  — the player weight (0 = critics only, 1 = players only). Set in the UI.
//   w′ — w scaled by review-volume confidence: a verdict from 1M reviews counts
//        fully; a thin one counts less; a game with no Steam data (console
//        exclusive) keeps its editorial score (w′ = 0).
//
// Why: professional review scores can drift from how players actually feel —
// blending in Steam's large-sample player sentiment corrects for that, and the
// knob lets you decide how much to trust each side.

export interface Game {
  title: string;
  year: number;
  developer: string;
  genre: string; // canonical bucket (used by table + filter)
  genreDetail: string; // original wording (shown in the per-game detail)
  platforms: ("PC" | "PlayStation")[];
  pcScore: number | null;
  psScore: number | null;
  metacritic: number | null;
  awards: string[];
  indie: boolean;
  modes: string[];
  note: string;
  steamAppId: number | null;
  steamPositive: number | null; // % of Steam reviews that are positive, 0–100
  steamReviews: number | null; // Steam review count (sample size)
}

export interface Ranked extends Game {
  composite: number; // final blended score, /100
  editorial: number; // mean of available editorial (critic-anchored) scores
  userScore: number | null; // Steam % positive (player sentiment), if any
  reviewConfidence: number; // 0–1, from review volume
  effWeight: number; // player weight actually applied after confidence scaling
  tier: Tier;
  provisional: boolean;
}

export type Tier = "S" | "A" | "A−" | "B" | "C";

export const CURRENT_YEAR = 2026;
const PROVISIONAL_AFTER = 2025; // releases this year or later have a thin long tail
const REVIEW_FULL = 50_000; // review count at which player sentiment is fully trusted
export const DEFAULT_USER_WEIGHT = 0.5; // balanced critics ↔ players

const editorialScores = (g: Game): number[] =>
  [g.pcScore, g.psScore].filter((s): s is number => s != null);

export function prior(games: Game[]): number {
  const all = games.flatMap(editorialScores);
  return all.reduce((a, b) => a + b, 0) / all.length;
}

export function isProvisional(g: Game): boolean {
  return g.year >= PROVISIONAL_AFTER;
}

// How much to trust the Steam player score, from its review volume (0–1).
// No Steam data → 0, so the game keeps its editorial score.
export function reviewConfidence(g: Game): number {
  if (g.steamPositive == null || !g.steamReviews) return 0;
  return Math.min(1, Math.log10(g.steamReviews) / Math.log10(REVIEW_FULL));
}

export function tierOf(score: number): Tier {
  if (score >= 92) return "S";
  if (score >= 88) return "A";
  if (score >= 85) return "A−";
  if (score >= 82) return "B";
  return "C";
}

// userWeight: 0 = critics only, 1 = players only.
export function rank(games: Game[], userWeight: number = DEFAULT_USER_WEIGHT): Ranked[] {
  const w = Math.min(1, Math.max(0, userWeight));
  return games
    .map((g) => {
      const scores = editorialScores(g);
      const editorial = scores.reduce((a, b) => a + b, 0) / scores.length;
      const conf = reviewConfidence(g);
      const effW = w * conf;
      const composite = g.steamPositive != null ? editorial * (1 - effW) + g.steamPositive * effW : editorial;
      return {
        ...g,
        composite: Math.round(composite * 10) / 10,
        editorial: Math.round(editorial * 10) / 10,
        userScore: g.steamPositive,
        reviewConfidence: Math.round(conf * 100) / 100,
        effWeight: Math.round(effW * 100) / 100,
        tier: tierOf(composite),
        provisional: isProvisional(g),
      };
    })
    .sort((a, b) => b.composite - a.composite || b.editorial - a.editorial || a.title.localeCompare(b.title));
}

// --- filtering --------------------------------------------------------------

export const MODES = ["Single-player", "Co-op", "PvP", "Live-service"] as const;
export type Mode = (typeof MODES)[number];

export interface Filters {
  yearMin: number;
  yearMax: number;
  platforms: { PC: boolean; PlayStation: boolean };
  modes: Record<Mode, boolean>;
  genre: string; // "" = all
  search: string;
  indieOnly: boolean;
}

export function applyFilters(games: Game[], f: Filters): Game[] {
  const q = f.search.trim().toLowerCase();
  return games.filter((g) => {
    if (g.year < f.yearMin || g.year > f.yearMax) return false;
    if (!g.platforms.some((p) => f.platforms[p])) return false;
    if (!g.modes.some((m) => f.modes[m as Mode])) return false;
    if (f.genre && g.genre !== f.genre) return false;
    if (f.indieOnly && !g.indie) return false;
    if (q && !`${g.title} ${g.developer} ${g.genre} ${g.genreDetail}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function genres(games: Game[]): string[] {
  return [...new Set(games.map((g) => g.genre))].filter((g) => g && g !== "—").sort();
}

export const TIER_LABEL: Record<Tier, string> = {
  S: "S · Generational",
  A: "A · Essential",
  "A−": "A− · Standout",
  B: "B · Recommended",
  C: "C · Notable",
};
