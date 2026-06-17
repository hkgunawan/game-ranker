// The ranking algorithm.
//
// Games are discovered automatically from RAWG (no curated docs). Each game
// carries up to three signals, all normalized to /100:
//
//   critics  — Metacritic aggregate (the professional-review side)
//   players  — Steam % positive if the game is on Steam (large-sample player
//              sentiment), otherwise the RAWG community rating (×20)
//
// The composite blends critics and players, and the balance is a live knob:
//
//   composite = critics·(1 − w′) + players·w′
//
//   w  — the player weight (0 = critics only, 1 = players only). Set in the UI.
//        It DEFAULTS player-heavy on purpose: pro scores can drift from how
//        people who actually play the game feel, so players carry more weight.
//   w′ — w scaled by sample-size confidence: a verdict from a million Steam
//        reviews counts fully, a thin one counts less. A game with no critic
//        score rides on players alone; one with no player data keeps critics.
//
// Why player-leaning: large-sample player sentiment is harder to skew than a
// handful of professional reviews, so it's the more trustworthy default.

export interface Game {
  title: string;
  year: number;
  developer: string;
  genre: string; // canonical bucket (used by table + filter)
  genreDetail: string; // original RAWG genres (shown in the per-game detail)
  platforms: ("PC" | "PlayStation")[];
  metacritic: number | null; // critic aggregate, 0–100
  rawgRating: number | null; // RAWG community rating, 0–5
  rawgRatingsCount: number | null; // sample size behind the RAWG rating
  indie: boolean;
  modes: string[];
  note: string; // short blurb
  rawgSlug: string;
  steamAppId: number | null;
  steamPositive: number | null; // % of Steam reviews that are positive, 0–100
  steamReviews: number | null; // Steam review count (sample size)
}

export type PlayerSource = "steam" | "rawg";

export interface Ranked extends Game {
  composite: number; // final blended score, /100
  critics: number | null; // critic signal used (Metacritic)
  players: number | null; // player signal used (Steam % or RAWG×20)
  playerSource: PlayerSource | null;
  playerSample: number; // reviews/ratings behind the player signal
  confidence: number; // 0–1, from player sample size
  effWeight: number; // player weight actually applied after confidence scaling
  tier: Tier;
  provisional: boolean;
}

export type Tier = "S" | "A" | "A−" | "B" | "C";

export const CURRENT_YEAR = 2026;
const PROVISIONAL_AFTER = 2025; // releases this year or later have a thin long tail
const SAMPLE_FULL = 20_000; // player-sample size at which the verdict is fully trusted
export const DEFAULT_USER_WEIGHT = 0.7; // player-leaning by default (critics drift)

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// The player-side signal: prefer Steam (huge samples, explicit % positive),
// fall back to RAWG's community rating (0–5 → /100). null if neither exists.
function playerSignal(g: Game): { score: number; source: PlayerSource; sample: number } | null {
  if (g.steamPositive != null && g.steamReviews) {
    return { score: g.steamPositive, source: "steam", sample: g.steamReviews };
  }
  if (g.rawgRating != null && g.rawgRatingsCount) {
    return { score: g.rawgRating * 20, source: "rawg", sample: g.rawgRatingsCount };
  }
  return null;
}

export function prior(games: Game[]): number {
  const crit = games.map((g) => g.metacritic).filter((s): s is number => s != null);
  if (!crit.length) return 80;
  return crit.reduce((a, b) => a + b, 0) / crit.length;
}

export function isProvisional(g: Game): boolean {
  return g.year >= PROVISIONAL_AFTER;
}

// How much to trust the player score, from its sample size (0–1).
export function confidenceOf(sample: number): number {
  if (!sample) return 0;
  return Math.min(1, Math.log10(sample) / Math.log10(SAMPLE_FULL));
}

// Cutoffs calibrated against the live RAWG+Steam distribution so the tiers stay
// meaningful (S ≈ top 8%, not half the board) under the player-heavy default.
export function tierOf(score: number): Tier {
  if (score >= 94) return "S";
  if (score >= 91) return "A";
  if (score >= 88) return "A−";
  if (score >= 85) return "B";
  return "C";
}

// userWeight: 0 = critics only, 1 = players only.
export function rank(games: Game[], userWeight: number = DEFAULT_USER_WEIGHT): Ranked[] {
  const w = clamp(userWeight, 0, 1);
  return games
    .map((g) => {
      const crit = g.metacritic;
      const ps = playerSignal(g);
      const conf = ps ? confidenceOf(ps.sample) : 0;

      let composite: number;
      let effW: number;
      if (crit == null && ps == null) {
        composite = 0; // no signal at all — should be filtered out upstream
        effW = 0;
      } else if (crit == null) {
        composite = ps!.score; // players-only
        effW = 1;
      } else if (ps == null) {
        composite = crit; // critics-only
        effW = 0;
      } else {
        effW = w * conf;
        composite = crit * (1 - effW) + ps.score * effW;
      }

      return {
        ...g,
        composite: round1(composite),
        critics: crit,
        players: ps ? round1(ps.score) : null,
        playerSource: ps?.source ?? null,
        playerSample: ps?.sample ?? 0,
        confidence: round2(conf),
        effWeight: round2(effW),
        tier: tierOf(composite),
        provisional: isProvisional(g),
      };
    })
    .sort((a, b) => b.composite - a.composite || (b.critics ?? 0) - (a.critics ?? 0) || a.title.localeCompare(b.title));
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
