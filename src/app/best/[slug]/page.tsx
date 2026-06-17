import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import gamesData from "@/data/games.json";
import {
  rank,
  applyFilters,
  genres,
  CURRENT_YEAR,
  TIER_LABEL,
  type Game,
  type Ranked,
  type Tier,
  type Filters,
} from "@/lib/rank";

// Statically-generated, shareable "best of" pages: /best/2024, /best/rpg,
// /best/indie, … Each is a server-rendered top-25 snapshot of the same ranking
// the interactive board uses, with its own title/description so links preview
// nicely when shared. Only the curated slugs below exist (dynamicParams=false).
export const dynamicParams = false;

const GAMES = gamesData as Game[];
const RANKED = rank(GAMES); // default player-leaning weight, computed once at build

const TIER_COLOR: Record<Tier, string> = {
  S: "text-[#d29922] border-[#d29922]/40 bg-[#d29922]/10",
  A: "text-[#3fb950] border-[#3fb950]/40 bg-[#3fb950]/10",
  "A−": "text-[#58a6ff] border-[#58a6ff]/40 bg-[#58a6ff]/10",
  B: "text-[#8b949e] border-[#8b949e]/40 bg-[#8b949e]/10",
  C: "text-[#7d8590] border-[#7d8590]/40 bg-[#7d8590]/10",
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const GENRE_BY_SLUG = new Map(genres(GAMES).map((g) => [slugify(g), g]));
const PRESET_YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020];
const TOP_N = 25;

const baseFilter = (): Filters => ({
  yearMin: 1990,
  yearMax: CURRENT_YEAR,
  platforms: { PC: true, PlayStation: true },
  modes: { "Single-player": true, "Co-op": true, PvP: true, "Live-service": true },
  genre: "",
  search: "",
  indie: "all",
});

interface View {
  heading: string;
  blurb: string;
  filter: Filters;
  exploreHref: string;
}

function resolve(slug: string): View | null {
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

export function generateStaticParams() {
  return [
    ...PRESET_YEARS.map((y) => ({ slug: String(y) })),
    ...[...GENRE_BY_SLUG.keys()].map((slug) => ({ slug })),
    { slug: "indie" },
  ];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const v = resolve(slug);
  if (!v) return {};
  const title = `${v.heading} — game-ranker`;
  return {
    title,
    description: v.blurb,
    alternates: { canonical: `/best/${slug}` },
    openGraph: { title, description: v.blurb, type: "website", url: `/best/${slug}` },
    twitter: { card: "summary", title, description: v.blurb },
  };
}

export default async function BestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const v = resolve(slug);
  if (!v) notFound();
  const list = (applyFilters(RANKED, v.filter) as Ranked[]).slice(0, TOP_N);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-mono text-lg text-[#e6edf3]">
          <span className="text-[#3fb950]">$</span> {v.heading.toLowerCase()}
        </h1>
        <Link href="/" className="font-mono text-xs text-[#8b949e] hover:text-[#e6edf3]">
          ← all games
        </Link>
      </header>

      <p className="mb-5 max-w-3xl font-mono text-xs leading-relaxed text-[#8b949e]">
        {v.blurb} Showing the top {Math.min(TOP_N, list.length)}.{" "}
        <Link href={v.exploreHref} className="text-[#58a6ff] hover:underline">
          Open in the interactive ranker →
        </Link>
      </p>

      {list.length === 0 ? (
        <p className="rounded-lg border border-[#30363d] bg-[#0d1117] p-8 text-center font-mono text-sm text-[#8b949e]">
          No games match this view yet.
        </p>
      ) : (
        <section className="overflow-x-auto rounded-lg border border-[#30363d] bg-[#0d1117]">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[#21262d] font-mono text-[11px] uppercase text-[#7d8590]">
                <th className="py-2 pl-3 pr-2">#</th>
                <th className="py-2 pr-3">Game</th>
                <th className="py-2 pr-3">Year</th>
                <th className="py-2 pr-3">Platform</th>
                <th className="py-2 pr-3">Tier</th>
                <th className="py-2 pr-3 text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {list.map((g, i) => (
                <tr key={g.title} className="border-b border-[#161b22]">
                  <td className="py-2 pl-3 pr-2 font-mono text-xs text-[#7d8590]">{i + 1}</td>
                  <td className="py-2 pr-3">
                    <span className="text-sm text-[#e6edf3]">{g.title}</span>
                    {g.indie && <span className="ml-1.5 text-[10px] text-[#a371f7]">◆</span>}
                    <span className="ml-2 font-mono text-[11px] text-[#7d8590]">{g.developer}</span>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-[#8b949e]">{g.year}</td>
                  <td className="py-2 pr-3">
                    <span className="flex gap-1">
                      {g.platforms.map((p) => (
                        <span
                          key={p}
                          title={p}
                          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                            p === "PC" ? "text-[#3fb950] border-[#3fb950]/40" : "text-[#a371f7] border-[#a371f7]/40"
                          }`}
                        >
                          {p === "PC" ? "PC" : "PS"}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${TIER_COLOR[g.tier]}`}
                      title={TIER_LABEL[g.tier]}
                    >
                      {g.tier}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-sm font-semibold text-[#e6edf3]">{g.composite}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="mt-8 text-center font-mono text-xs text-[#7d8590]">
        ranked from {GAMES.length} games · Metacritic blended with Steam player reviews · refreshed weekly ·{" "}
        <Link href="/" className="text-[#58a6ff] hover:underline">
          explore all
        </Link>
      </footer>
    </main>
  );
}
