"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import gamesData from "@/data/games.json";
import {
  rank,
  applyFilters,
  genres,
  MODES,
  TIER_LABEL,
  CURRENT_YEAR,
  DEFAULT_USER_WEIGHT,
  type Game,
  type Ranked,
  type Tier,
  type Mode,
  type Filters,
} from "@/lib/rank";
import { useTableSort, SortTh } from "@/components/sortable";

const GAMES = gamesData as Game[];
const ALL_GENRES = genres(GAMES);
const MIN_YEAR = Math.min(...GAMES.map((g) => g.year));

const DEFAULT_FILTERS: Filters = {
  yearMin: 2015,
  yearMax: CURRENT_YEAR,
  platforms: { PC: true, PlayStation: true },
  modes: { "Single-player": true, "Co-op": true, PvP: true, "Live-service": true },
  genre: "",
  search: "",
  indieOnly: false,
};

const MODE_SHORT: Record<Mode, string> = {
  "Single-player": "sp",
  "Co-op": "coop",
  PvP: "pvp",
  "Live-service": "live",
};
const MODE_LABEL: Record<Mode, string> = {
  "Single-player": "SP",
  "Co-op": "Co-op",
  PvP: "PvP",
  "Live-service": "Live",
};

const TIER_COLOR: Record<Tier, string> = {
  S: "text-[#d29922] border-[#d29922]/40 bg-[#d29922]/10",
  A: "text-[#3fb950] border-[#3fb950]/40 bg-[#3fb950]/10",
  "A−": "text-[#58a6ff] border-[#58a6ff]/40 bg-[#58a6ff]/10",
  B: "text-[#8b949e] border-[#8b949e]/40 bg-[#8b949e]/10",
  C: "text-[#484f58] border-[#484f58]/40 bg-[#484f58]/10",
};

// --- URL <-> filter state (shareable, linkable views) -----------------------

function filtersToQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.yearMin !== DEFAULT_FILTERS.yearMin || f.yearMax !== DEFAULT_FILTERS.yearMax)
    p.set("y", `${f.yearMin}-${f.yearMax}`);
  const plats = (["PC", "PlayStation"] as const).filter((k) => f.platforms[k]);
  if (plats.length !== 2) p.set("plat", plats.map((k) => (k === "PC" ? "pc" : "ps")).join(","));
  const modes = MODES.filter((m) => f.modes[m]);
  if (modes.length !== MODES.length) p.set("mode", modes.map((m) => MODE_SHORT[m]).join(","));
  if (f.genre) p.set("genre", f.genre);
  if (f.search) p.set("q", f.search);
  if (f.indieOnly) p.set("indie", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}

function filtersFromQuery(search: string): Filters {
  const p = new URLSearchParams(search);
  const f: Filters = structuredClone(DEFAULT_FILTERS);
  const y = p.get("y")?.match(/^(\d{4})-(\d{4})$/);
  if (y) {
    f.yearMin = Math.max(MIN_YEAR, Math.min(+y[1], +y[2]));
    f.yearMax = Math.min(CURRENT_YEAR, Math.max(+y[1], +y[2]));
  }
  const plat = p.get("plat");
  if (plat) {
    const set = new Set(plat.split(","));
    f.platforms = { PC: set.has("pc"), PlayStation: set.has("ps") };
    if (!f.platforms.PC && !f.platforms.PlayStation) f.platforms = DEFAULT_FILTERS.platforms;
  }
  const mode = p.get("mode");
  if (mode) {
    const set = new Set(mode.split(","));
    const next = {} as Record<Mode, boolean>;
    for (const m of MODES) next[m] = set.has(MODE_SHORT[m]);
    if (MODES.some((m) => next[m])) f.modes = next;
  }
  const genre = p.get("genre");
  if (genre && ALL_GENRES.includes(genre)) f.genre = genre;
  f.search = p.get("q") ?? "";
  f.indieOnly = p.get("indie") === "1";
  return f;
}

function Detail({ g }: { g: Ranked }) {
  const playerLabel = g.playerSource === "steam" ? "Steam" : g.playerSource === "rawg" ? "RAWG" : "—";
  return (
    <div className="grid gap-3 px-3 py-3 text-xs sm:grid-cols-[1fr_auto]">
      <div className="space-y-2">
        <p className="font-mono text-[11px] text-[#484f58]">
          {g.genreDetail} · {g.modes.join(" / ")}
        </p>
        {g.note && <p className="leading-relaxed text-[#8b949e]">{g.note}</p>}
        <div className="flex flex-wrap gap-1.5">
          {g.indie && (
            <span className="rounded border border-[#a371f7]/40 px-1.5 py-0.5 font-mono text-[10px] text-[#a371f7]">
              ◆ indie
            </span>
          )}
          {g.provisional && (
            <span
              className="rounded border border-[#484f58] px-1.5 py-0.5 font-mono text-[10px] text-[#8b949e]"
              title="released recently — long-tail reviews still settling, so the player score carries less weight"
            >
              provisional
            </span>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 self-start font-mono text-[11px] sm:text-right">
        <dt className="text-[#484f58]" title="Metacritic critic aggregate">
          critics
        </dt>
        <dd className="text-[#58a6ff]">{g.critics ?? "—"}</dd>
        <dt className="text-[#484f58]" title={`player sentiment (${playerLabel})`}>
          players ({playerLabel})
        </dt>
        <dd className="text-[#3fb950]">
          {g.players != null ? `${g.players}${g.playerSource === "steam" ? "%" : ""}` : "—"}
          {g.playerSample > 0 && <span className="text-[#484f58]"> ({g.playerSample.toLocaleString()})</span>}
        </dd>
        <dt className="text-[#484f58]" title="how much the player score is trusted, from sample size">
          confidence
        </dt>
        <dd className="text-[#8b949e]">{Math.round(g.confidence * 100)}%</dd>
        <dt className="text-[#484f58]">composite</dt>
        <dd className="font-semibold text-[#e6edf3]">{g.composite}</dd>
      </dl>
    </div>
  );
}

export default function Home() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [userPct, setUserPct] = useState(Math.round(DEFAULT_USER_WEIGHT * 100)); // 0=critics, 100=players
  const [showMethod, setShowMethod] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // hydrate filters + weighting from the URL after mount (SSR renders defaults first)
  useEffect(() => {
    if (window.location.search) {
      const p = new URLSearchParams(window.location.search);
      const w = p.get("w");
      /* eslint-disable react-hooks/set-state-in-effect */
      setFilters(filtersFromQuery(window.location.search));
      if (w != null && /^\d{1,3}$/.test(w)) setUserPct(Math.min(100, +w));
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, []);

  // keep the URL in sync so any filtered view is shareable / linkable
  useEffect(() => {
    const q = filtersToQuery(filters);
    const wPart = userPct === Math.round(DEFAULT_USER_WEIGHT * 100) ? "" : `${q ? "&" : "?"}w=${userPct}`;
    window.history.replaceState(null, "", `${window.location.pathname}${q}${wPart}`);
  }, [filters, userPct]);

  const set = useCallback(
    <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value })),
    []
  );

  // global ranking at the current critic↔player weight (recomputed live as the slider moves)
  const ranked = useMemo(() => rank(GAMES, userPct / 100), [userPct]);
  const visible = useMemo(() => applyFilters(ranked, filters) as Ranked[], [ranked, filters]);

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
        The best PC &amp; PlayStation games, 2015→today — {GAMES.length} titles discovered automatically from RAWG,
        scored with Metacritic (critics) and real Steam player sentiment. Defaults{" "}
        <span className="text-[#3fb950]">player-leaning</span> on purpose. Slide the{" "}
        <span className="text-[#e6edf3]">critics ↔ players</span> weighting to re-rank live; filter by year, platform and
        mode; click any row for the breakdown.
      </p>

      {showMethod && (
        <section className="mb-5 rounded-lg border border-[#30363d] bg-[#0d1117] p-4 font-mono text-xs leading-relaxed text-[#8b949e]">
          <p className="mb-2 text-[#e6edf3]">How the score is computed</p>
          <p className="mb-2">
            Games are pulled automatically from RAWG. Each carries a{" "}
            <span className="text-[#58a6ff]">critics</span> score (Metacritic) and a{" "}
            <span className="text-[#3fb950]">players</span> score — Steam % positive where the game is on Steam, otherwise
            the RAWG community rating. The composite blends them:
          </p>
          <p className="mb-2 pl-1 text-[#e6edf3]">composite = critics·(1−w′) + players·w′</p>
          <ol className="mb-2 list-decimal space-y-1 pl-5">
            <li>
              <span className="text-[#e6edf3]">w</span> is the player weight you set with the slider (0 = critics only, 1
              = players only). It <span className="text-[#3fb950]">defaults player-heavy</span> — pro scores can drift
              from how people who actually play feel.
            </li>
            <li>
              <span className="text-[#e6edf3]">w′</span> scales <span className="text-[#e6edf3]">w</span> by sample size —
              a verdict from a million reviews counts fully, a thin one less. No critic score → players alone; no player
              data → critics alone.
            </li>
          </ol>
          <p>
            Why player-leaning: large-sample player sentiment is harder to skew than a handful of professional reviews.
            Scores are global — filtering changes what&apos;s shown, never the scores.
          </p>
        </section>
      )}

      {/* filter bar */}
      <section className="mb-5 space-y-3 rounded-lg border border-[#30363d] bg-[#0d1117] p-4">
        <div className="flex flex-wrap items-center gap-3 border-b border-[#21262d] pb-3 font-mono text-xs">
          <span className="text-[#484f58]">weighting</span>
          <span className={userPct < 50 ? "text-[#58a6ff]" : "text-[#8b949e]"}>critics</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={userPct}
            onChange={(e) => setUserPct(+e.target.value)}
            aria-label="Critics to players weighting"
            className="h-1 w-40 cursor-pointer accent-emerald-500"
          />
          <span className={userPct > 50 ? "text-[#3fb950]" : "text-[#8b949e]"}>players</span>
          <span className="text-[#484f58]">
            · {100 - userPct}% critics / {userPct}% players (Steam · RAWG)
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2 font-mono text-xs text-[#8b949e]">
            <span className="text-[#484f58]">years</span>
            <select
              value={filters.yearMin}
              onChange={(e) => set("yearMin", Math.min(+e.target.value, filters.yearMax))}
              aria-label="From year"
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
              aria-label="To year"
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

          <div className="flex items-center gap-3 font-mono text-xs">
            <span className="text-[#484f58]">mode</span>
            {MODES.map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-1.5 text-[#8b949e] hover:text-[#e6edf3]">
                <input
                  type="checkbox"
                  checked={filters.modes[m]}
                  onChange={(e) => set("modes", { ...filters.modes, [m]: e.target.checked })}
                  className="accent-emerald-500"
                />
                {MODE_LABEL[m]}
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2 font-mono text-xs text-[#8b949e]">
            <span className="text-[#484f58]">genre</span>
            <select
              value={filters.genre}
              onChange={(e) => set("genre", e.target.value)}
              aria-label="Genre"
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

          <label className="flex cursor-pointer items-center gap-1.5 font-mono text-xs text-[#8b949e] hover:text-[#e6edf3]">
            <input
              type="checkbox"
              checked={filters.indieOnly}
              onChange={(e) => set("indieOnly", e.target.checked)}
              className="accent-emerald-500"
            />
            indie only ◆
          </label>

          <input
            value={filters.search}
            onChange={(e) => set("search", e.target.value)}
            placeholder="search title, studio…"
            aria-label="Search"
            className="min-w-0 flex-1 rounded border border-[#30363d] bg-transparent px-2 py-1 font-mono text-xs text-[#e6edf3] placeholder-[#484f58] outline-none focus:border-emerald-500/60"
          />

          <button
            onClick={() => setFilters(structuredClone(DEFAULT_FILTERS))}
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
              const toggleRow = () => setExpanded(open ? null : g.title);
              return (
                <Fragment key={g.title}>
                  <tr
                    onClick={toggleRow}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleRow();
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-expanded={open}
                    aria-label={`${g.title} — score ${g.composite}. Toggle details.`}
                    className="cursor-pointer border-b border-[#161b22] hover:bg-[#161b22] focus:bg-[#161b22] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-emerald-500/60"
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
                    <td className="max-w-[12rem] truncate py-2 pr-3 text-xs text-[#8b949e]" title={g.genreDetail}>
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
        {GAMES.length} games · auto-discovered from RAWG · Metacritic blended with Steam player reviews · refreshed
        weekly · not affiliated with any publisher
      </footer>
    </main>
  );
}

function PlatformBadge({ p }: { p: "PC" | "PlayStation" }) {
  const cls = p === "PC" ? "text-[#3fb950] border-[#3fb950]/40" : "text-[#a371f7] border-[#a371f7]/40";
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${cls}`} title={p}>
      {p === "PC" ? "PC" : "PS"}
    </span>
  );
}
