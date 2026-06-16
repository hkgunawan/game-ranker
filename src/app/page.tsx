"use client";

import { Fragment, useMemo, useState } from "react";
import gamesData from "@/data/games.json";
import {
  rank,
  applyFilters,
  genres,
  TIER_LABEL,
  CURRENT_YEAR,
  type Game,
  type Ranked,
  type Tier,
  type Filters,
} from "@/lib/rank";
import { useTableSort, SortTh } from "@/components/sortable";

const GAMES = gamesData as Game[];
const RANKED = rank(GAMES); // global ranking — scores are stable regardless of filters
const ALL_GENRES = genres(GAMES);
const MIN_YEAR = Math.min(...GAMES.map((g) => g.year));

const TIER_COLOR: Record<Tier, string> = {
  S: "text-[#d29922] border-[#d29922]/40 bg-[#d29922]/10",
  A: "text-[#3fb950] border-[#3fb950]/40 bg-[#3fb950]/10",
  "A−": "text-[#58a6ff] border-[#58a6ff]/40 bg-[#58a6ff]/10",
  B: "text-[#8b949e] border-[#8b949e]/40 bg-[#8b949e]/10",
  C: "text-[#484f58] border-[#484f58]/40 bg-[#484f58]/10",
};

function PlatformBadge({ p }: { p: "PC" | "PlayStation" }) {
  const cls = p === "PC" ? "text-[#3fb950] border-[#3fb950]/40" : "text-[#a371f7] border-[#a371f7]/40";
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${cls}`} title={p}>
      {p === "PC" ? "PC" : "PS"}
    </span>
  );
}

function Detail({ g }: { g: Ranked }) {
  return (
    <div className="grid gap-3 px-3 py-3 text-xs sm:grid-cols-[1fr_auto]">
      <div className="space-y-2">
        {g.note && <p className="leading-relaxed text-[#8b949e]">{g.note}</p>}
        <div className="flex flex-wrap gap-1.5">
          {g.awards.map((a) => (
            <span key={a} className="rounded border border-[#d29922]/40 px-1.5 py-0.5 font-mono text-[10px] text-[#d29922]">
              🏆 {a}
            </span>
          ))}
          {g.indie && (
            <span className="rounded border border-[#a371f7]/40 px-1.5 py-0.5 font-mono text-[10px] text-[#a371f7]">
              ◆ indie
            </span>
          )}
          {g.provisional && (
            <span className="rounded border border-[#484f58] px-1.5 py-0.5 font-mono text-[10px] text-[#8b949e]" title="released recently — long-tail reviews still settling, so the score is shrunk toward the mean">
              provisional
            </span>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 self-start font-mono text-[11px] sm:text-right">
        <dt className="text-[#484f58]">PC score</dt>
        <dd className="text-[#e6edf3]">{g.pcScore ?? "—"}</dd>
        <dt className="text-[#484f58]">PS score</dt>
        <dd className="text-[#e6edf3]">{g.psScore ?? "—"}</dd>
        <dt className="text-[#484f58]">Metacritic</dt>
        <dd className="text-[#e6edf3]">{g.metacritic ?? "—"}</dd>
        <dt className="text-[#484f58]">raw mean</dt>
        <dd className="text-[#e6edf3]">{g.rawMean}</dd>
        <dt className="text-[#484f58]">evidence n</dt>
        <dd className="text-[#e6edf3]">{g.evidence}</dd>
        <dt className="text-[#484f58]">composite</dt>
        <dd className="font-semibold text-[#3fb950]">{g.composite}</dd>
      </dl>
    </div>
  );
}

export default function Home() {
  const [filters, setFilters] = useState<Filters>({
    yearMin: 2015,
    yearMax: CURRENT_YEAR,
    platforms: { PC: true, PlayStation: true },
    genre: "",
    search: "",
    indieOnly: false,
  });
  const [showMethod, setShowMethod] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));

  const visible = useMemo(() => applyFilters(RANKED, filters) as Ranked[], [filters]);

  const { sorted, sort, toggle } = useTableSort<Ranked>(
    visible,
    {
      composite: (r) => r.composite,
      title: (r) => r.title,
      year: (r) => r.year,
      genre: (r) => r.genre,
      tier: (r) => -["S", "A", "A−", "B", "C"].indexOf(r.tier),
    },
    { key: "composite", dir: "desc" }
  );

  const years = Array.from({ length: CURRENT_YEAR - MIN_YEAR + 1 }, (_, i) => CURRENT_YEAR - i);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-mono text-lg text-[#e6edf3]">
          <span className="text-[#3fb950]">$</span> game-ranker
        </h1>
        <button
          onClick={() => setShowMethod((s) => !s)}
          className="font-mono text-xs text-[#8b949e] hover:text-[#e6edf3]"
        >
          {showMethod ? "hide" : "how scoring works"} ▾
        </button>
      </header>

      <p className="mb-4 max-w-3xl font-mono text-xs leading-relaxed text-[#8b949e]">
        The best PC &amp; PlayStation games, 2015→today — {GAMES.length} titles merged from two curated rankings and
        re-scored with one transparent algorithm. Filter by year and platform; click any row for the breakdown.
      </p>

      {showMethod && (
        <section className="mb-5 rounded-lg border border-[#30363d] bg-[#0d1117] p-4 font-mono text-xs leading-relaxed text-[#8b949e]">
          <p className="mb-2 text-[#e6edf3]">How the score is computed</p>
          <p className="mb-2">
            Each game starts from expert /100 composites (7 weighted axes for PC, 6 for PS5 — both anchored on critical
            consensus + long-tail player reception). I merge the two and apply a small{" "}
            <span className="text-[#e6edf3]">Bayesian model</span>:
          </p>
          <ol className="mb-2 list-decimal space-y-1 pl-5">
            <li>
              <span className="text-[#e6edf3]">Evidence (n)</span> — a game reviewed on both platforms carries two
              independent verdicts; older titles have a settled long tail, so they count for more.
            </li>
            <li>
              <span className="text-[#e6edf3]">Shrinkage</span> — composite = (raw·n + prior·k) / (n + k). Thin evidence
              is pulled toward the dataset mean; strong evidence stays put.
            </li>
            <li>
              <span className="text-[#e6edf3]">Corroboration</span> — a small bump when both platforms independently rate
              a game highly.
            </li>
          </ol>
          <p>
            Net effect: generational cross-platform classics rise; brand-new single-platform titles cool off slightly
            until their reviews settle (these are marked <span className="text-[#e6edf3]">provisional</span>). Scores are
            global — filtering never changes them, only what&apos;s shown.
          </p>
        </section>
      )}

      {/* filter bar */}
      <section className="mb-5 space-y-3 rounded-lg border border-[#30363d] bg-[#0d1117] p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2 font-mono text-xs text-[#8b949e]">
            <span className="text-[#484f58]">years</span>
            <select
              value={filters.yearMin}
              onChange={(e) => set("yearMin", Math.min(+e.target.value, filters.yearMax))}
              className="rounded border border-[#30363d] bg-transparent px-2 py-1 text-[#e6edf3] outline-none focus:border-emerald-500/60"
            >
              {years.map((y) => (
                <option key={y} value={y} className="bg-[#0d1117]">
                  {y}
                </option>
              ))}
            </select>
            <span className="text-[#484f58]">→</span>
            <select
              value={filters.yearMax}
              onChange={(e) => set("yearMax", Math.max(+e.target.value, filters.yearMin))}
              className="rounded border border-[#30363d] bg-transparent px-2 py-1 text-[#e6edf3] outline-none focus:border-emerald-500/60"
            >
              {years.map((y) => (
                <option key={y} value={y} className="bg-[#0d1117]">
                  {y}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3 font-mono text-xs">
            <span className="text-[#484f58]">platform</span>
            {(["PC", "PlayStation"] as const).map((p) => (
              <label key={p} className="flex cursor-pointer items-center gap-1.5 text-[#8b949e] hover:text-[#e6edf3]">
                <input
                  type="checkbox"
                  checked={filters.platforms[p]}
                  onChange={(e) => set("platforms", { ...filters.platforms, [p]: e.target.checked })}
                  className="accent-emerald-500"
                />
                {p}
              </label>
            ))}
          </div>

          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-xs text-[#8b949e] hover:text-[#e6edf3]">
            <input
              type="checkbox"
              checked={filters.indieOnly}
              onChange={(e) => set("indieOnly", e.target.checked)}
              className="accent-emerald-500"
            />
            indie only ◆
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2 font-mono text-xs text-[#8b949e]">
            <span className="text-[#484f58]">genre</span>
            <select
              value={filters.genre}
              onChange={(e) => set("genre", e.target.value)}
              className="max-w-[14rem] rounded border border-[#30363d] bg-transparent px-2 py-1 text-[#e6edf3] outline-none focus:border-emerald-500/60"
            >
              <option value="" className="bg-[#0d1117]">
                all genres
              </option>
              {ALL_GENRES.map((g) => (
                <option key={g} value={g} className="bg-[#0d1117]">
                  {g}
                </option>
              ))}
            </select>
          </div>

          <input
            value={filters.search}
            onChange={(e) => set("search", e.target.value)}
            placeholder="search title, studio…"
            className="min-w-0 flex-1 rounded border border-[#30363d] bg-transparent px-2 py-1 font-mono text-xs text-[#e6edf3] placeholder-[#484f58] outline-none focus:border-emerald-500/60"
          />

          <button
            onClick={() =>
              setFilters({
                yearMin: 2015,
                yearMax: CURRENT_YEAR,
                platforms: { PC: true, PlayStation: true },
                genre: "",
                search: "",
                indieOnly: false,
              })
            }
            className="rounded border border-[#30363d] px-2 py-1 font-mono text-xs text-[#8b949e] hover:border-emerald-500/60 hover:text-[#3fb950]"
          >
            reset
          </button>
        </div>

        <p className="font-mono text-[11px] text-[#484f58]">
          showing <span className="text-[#8b949e]">{sorted.length}</span> of {GAMES.length} games
        </p>
      </section>

      {/* leaderboard */}
      <section className="overflow-x-auto rounded-lg border border-[#30363d] bg-[#0d1117]">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-[#21262d] font-mono text-[11px] uppercase text-[#484f58]">
              <th className="py-2 pl-3 pr-2">#</th>
              <SortTh label="Game" sortKey="title" sort={sort} onSort={toggle} className="py-2 pr-3" />
              <SortTh label="Year" sortKey="year" sort={sort} onSort={toggle} className="py-2 pr-3" />
              <th className="py-2 pr-3">Platform</th>
              <SortTh label="Genre" sortKey="genre" sort={sort} onSort={toggle} className="py-2 pr-3" />
              <SortTh label="Tier" sortKey="tier" sort={sort} onSort={toggle} className="py-2 pr-3" />
              <SortTh
                label="Score"
                sortKey="composite"
                sort={sort}
                onSort={toggle}
                title="composite algorithm score /100"
                className="py-2 pr-3 text-right"
              />
            </tr>
          </thead>
          <tbody>
            {sorted.map((g, i) => {
              const open = expanded === g.title;
              return (
                <Fragment key={g.title}>
                  <tr
                    onClick={() => setExpanded(open ? null : g.title)}
                    className="cursor-pointer border-b border-[#161b22] hover:bg-[#161b22]"
                  >
                    <td className="py-2 pl-3 pr-2 font-mono text-xs text-[#484f58]">{i + 1}</td>
                    <td className="py-2 pr-3">
                      <span className="text-sm text-[#e6edf3]">{g.title}</span>
                      {g.indie && <span className="ml-1.5 text-[10px] text-[#a371f7]">◆</span>}
                      <span className="ml-2 font-mono text-[11px] text-[#484f58]">{g.developer}</span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs text-[#8b949e]">{g.year}</td>
                    <td className="py-2 pr-3">
                      <span className="flex gap-1">
                        {g.platforms.map((p) => (
                          <PlatformBadge key={p} p={p} />
                        ))}
                      </span>
                    </td>
                    <td className="max-w-[12rem] truncate py-2 pr-3 text-xs text-[#8b949e]" title={g.genre}>
                      {g.genre}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${TIER_COLOR[g.tier]}`}
                        title={TIER_LABEL[g.tier]}
                      >
                        {g.tier}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-sm font-semibold text-[#e6edf3]">
                      {g.composite}
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-[#161b22] bg-[#0a0e14]">
                      <td colSpan={7}>
                        <Detail g={g} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} className="py-16 text-center font-mono text-sm text-[#484f58]">
                  no games match these filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="mt-8 text-center font-mono text-xs text-[#484f58]">
        {GAMES.length} games · scored with a transparent Bayesian model · opinionated, for fun · not affiliated with any
        publisher
      </footer>
    </main>
  );
}
