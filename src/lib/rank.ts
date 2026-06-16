// The ranking algorithm.
//
// Both source docs score on the same /100 conceptual scale (7 weighted axes for
// PC, 6 for PS5 — both anchored on critical consensus + long-tail reception).
// A naive merge would just average the two numbers. We do better: we weight by
// how much *evidence* stands behind each score, then shrink thin evidence toward
// the population mean. This is a small Bayesian model, and it's fully transparent.
//
//   1. Evidence (n)  — a game reviewed on BOTH platforms has two independent
//      expert assessments, so it carries more weight than a one-platform title.
//      Long-tail age matters too: the docs weight "Steam/PSN reviews 6+ months
//      post-launch" heavily, and explicitly flag post-Jun-2025 titles as
//      provisional (±2 expected drift). Older, settled scores = more evidence.
//
//   2. Shrinkage   — composite = (raw·n + prior·k) / (n + k). With thin evidence
//      the score is pulled toward the prior (the dataset mean); with strong
//      evidence it stays at its raw value. k is a mild prior strength.
//
//   3. Corroboration bonus — a small, capped bump when both platforms agree a
//      game is great (two independent panels reaching the same verdict).
//
// The result reorders the raw editorial numbers in a defensible way: generational
// cross-platform classics rise; hype-y brand-new single-platform entries cool off
// slightly until their long tail settles.

export interface Game {
  title: string;
  year: number;
  developer: string;
  genre: string;
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
const PRIOR_STRENGTH = 1.2; // k — how hard thin scores are pulled to the mean
const CROSS_BONUS = 0.8; // max bump for both-platform corroboration
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

// Evidence weight n: number of expert sources, scaled by how settled the long
// tail is (ramps 0→1 over the first 2 years; provisional titles are dampened).
function evidence(g: Game): number {
  const sources = editorialScores(g).length; // 1 or 2
  const age = CURRENT_YEAR - g.year;
  const tail = isProvisional(g) ? 0.4 : Math.min(1, Math.max(0.3, age / 2));
  return sources * (0.6 + 0.4 * tail);
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
      const n = evidence(g);
      const bayes = (rawMean * n + p * PRIOR_STRENGTH) / (n + PRIOR_STRENGTH);
      const cross = g.platforms.length === 2 ? CROSS_BONUS * (Math.min(...scores) / 100) : 0;
      const composite = Math.round((bayes + cross) * 10) / 10;
      return {
        ...g,
        composite,
        rawMean: Math.round(rawMean * 10) / 10,
        evidence: Math.round(n * 100) / 100,
        tier: tierOf(composite),
        provisional: isProvisional(g),
      };
    })
    .sort((a, b) => b.composite - a.composite || b.rawMean - a.rawMean || a.title.localeCompare(b.title));
}

// --- filtering --------------------------------------------------------------

export interface Filters {
  yearMin: number;
  yearMax: number;
  platforms: { PC: boolean; PlayStation: boolean };
  genre: string; // "" = all
  search: string;
  indieOnly: boolean;
}

export function applyFilters(games: Game[], f: Filters): Game[] {
  const q = f.search.trim().toLowerCase();
  return games.filter((g) => {
    if (g.year < f.yearMin || g.year > f.yearMax) return false;
    const platOk = g.platforms.some((p) => f.platforms[p]);
    if (!platOk) return false;
    if (f.genre && g.genre !== f.genre) return false;
    if (f.indieOnly && !g.indie) return false;
    if (q && !(`${g.title} ${g.developer} ${g.genre}`.toLowerCase().includes(q))) return false;
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
