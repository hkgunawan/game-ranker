// The ranking algorithm.
//
// Both source docs score on the same /100 conceptual scale (7 weighted axes for
// PC, 6 for PS5 — both anchored on critical consensus + long-tail reception).
// Those scores are themselves the output of a careful model, so we TRUST them —
// the only thing worth adjusting is genuine uncertainty.
//
// The docs weight "Steam/PSN reviews 6+ months post-launch" heavily and flag
// post-Jun-2025 titles as provisional (±2 expected drift). So a freshly released
// score is less trustworthy than one with years of settled reviews behind it.
//
//   Confidence (n) — high for a settled title (≥2 years of long-tail data),
//   low for a brand-new one. A second platform's verdict adds a little more.
//
//   Shrinkage — composite = (raw·n + prior·k) / (n + k). With n ≫ k a settled
//   score barely moves (it keeps its editorial value); only thin, recent scores
//   are nudged toward the dataset mean, by at most ~2–3 points.
//
// Net effect: settled classics sit at their real score regardless of platform
// (exclusives are not penalized); only brand-new titles are tempered until their
// reviews settle. Those are flagged "provisional" in the UI.

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
}

export interface Ranked extends Game {
  composite: number; // final algorithm score, /100
  rawMean: number; // simple mean of available editorial scores
  evidence: number; // n — how much the raw score is trusted
  tier: Tier;
  provisional: boolean;
}

export type Tier = "S" | "A" | "A−" | "B" | "C";

export const CURRENT_YEAR = 2026;
const PRIOR_STRENGTH = 0.8; // k — the prior is deliberately weak; we trust the editorial scores
const PROVISIONAL_AFTER = 2025; // releases this year or later have a thin long tail

const editorialScores = (g: Game): number[] =>
  [g.pcScore, g.psScore].filter((s): s is number => s != null);

export function prior(games: Game[]): number {
  const all = games.flatMap(editorialScores);
  return all.reduce((a, b) => a + b, 0) / all.length;
}

export function isProvisional(g: Game): boolean {
  return g.year >= PROVISIONAL_AFTER;
}

// Confidence weight n: how settled the score is. A title with 2+ years of
// long-tail reviews is high-confidence (n large ⇒ no shrinkage); a brand-new
// one is low-confidence (n small ⇒ nudged toward the prior). A second platform's
// independent verdict adds a little. Tuned so settled titles keep their score
// and the newest move by at most ~2–3 points.
function confidence(g: Game): number {
  const age = CURRENT_YEAR - g.year;
  const settle = age >= 2 ? 10 : age >= 1 ? 2.5 : 1.3; // per-source weight by recency
  const sources = editorialScores(g).length; // 1 or 2 independent verdicts
  return settle * (1 + 0.6 * (sources - 1)); // 2nd source adds 60%
}

export function tierOf(score: number): Tier {
  if (score >= 92) return "S";
  if (score >= 88) return "A";
  if (score >= 85) return "A−";
  if (score >= 82) return "B";
  return "C";
}

export function rank(games: Game[]): Ranked[] {
  const p = prior(games);
  return games
    .map((g) => {
      const scores = editorialScores(g);
      const rawMean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const n = confidence(g);
      const composite = (rawMean * n + p * PRIOR_STRENGTH) / (n + PRIOR_STRENGTH);
      return {
        ...g,
        composite: Math.round(composite * 10) / 10,
        rawMean: Math.round(rawMean * 10) / 10,
        evidence: Math.round(n * 100) / 100,
        tier: tierOf(composite),
        provisional: isProvisional(g),
      };
    })
    .sort((a, b) => b.composite - a.composite || b.rawMean - a.rawMean || a.title.localeCompare(b.title));
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
