// Shared logic for the static "best of" pages (/best/[slug]): slug resolution,
// the curated param set, and the ranked snapshot. Used by the page, its OG-image
// generator, and the sitemap so all three stay in sync.

import gamesData from "@/data/games.json";
import { rank, applyFilters, genres, CURRENT_YEAR, type Game, type Ranked, type Filters } from "./rank";

const GAMES = gamesData as Game[];
export const RANKED = rank(GAMES); // default player-leaning weight, computed once at build
export const GAME_COUNT = GAMES.length;

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const GENRE_BY_SLUG = new Map(genres(GAMES).map((g) => [slugify(g), g]));
// the seven most recent years, derived so it tracks CURRENT_YEAR automatically
const PRESET_YEARS = Array.from({ length: 7 }, (_, i) => CURRENT_YEAR - i);

export interface BestView {
  heading: string;
  blurb: string;
  filter: Filters;
  exploreHref: string;
}

const baseFilter = (): Filters => ({
  yearMin: 1990,
  yearMax: CURRENT_YEAR,
  platforms: { PC: true, PlayStation: true },
  modes: { "Single-player": true, "Co-op": true, PvP: true, "Live-service": true },
  genre: "",
  search: "",
  indie: "all",
});

export function resolveBest(slug: string): BestView | null {
  if (/^20\d{2}$/.test(slug)) {
    const y = Number(slug);
    if (y < 2010 || y > CURRENT_YEAR) return null;
    const filter = baseFilter();
    filter.yearMin = y;
    filter.yearMax = y;
    return {
      heading: `Best games of ${y}`,
      blurb: `The top-rated PC and PlayStation games released in ${y}, ranked by a blend of Metacritic critics and real player sentiment.`,
      filter,
      exploreHref: `/?y=${y}-${y}`,
    };
  }
  if (slug === "indie") {
    const filter = baseFilter();
    filter.indie = "only";
    return {
      heading: "Best indie games",
      blurb:
        "The top-rated independent games on PC and PlayStation, 2015→today, ranked by Metacritic critics and real player sentiment.",
      filter,
      exploreHref: `/?indie=only`,
    };
  }
  const genre = GENRE_BY_SLUG.get(slug);
  if (genre) {
    const filter = baseFilter();
    filter.genre = genre;
    return {
      heading: `Best ${genre} games`,
      blurb: `The top-rated ${genre} games on PC and PlayStation, 2015→today, ranked by a blend of Metacritic critics and real player sentiment.`,
      filter,
      exploreHref: `/?genre=${encodeURIComponent(genre)}`,
    };
  }
  return null;
}

// The curated set of slugs that get statically generated.
export function bestStaticParams(): { slug: string }[] {
  return [
    ...PRESET_YEARS.map((y) => ({ slug: String(y) })),
    ...[...GENRE_BY_SLUG.keys()].map((slug) => ({ slug })),
    { slug: "indie" },
  ];
}

export function topGames(v: BestView, n: number): Ranked[] {
  return (applyFilters(RANKED, v.filter) as Ranked[]).slice(0, n);
}
