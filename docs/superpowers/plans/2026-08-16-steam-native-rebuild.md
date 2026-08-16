# Steam-Native Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead RAWG pipeline with a Steam-native one so newly released games reach the board on merit, and stop thin-sample games scoring as if they were certainties.

**Architecture:** SteamSpy supplies ~10,000 candidate appids with review counts in ten calls; Steam's own `appdetails` supplies release date, genres, categories, developer, blurb and Metacritic; Steam's `appreviews` supplies exact sentiment for the survivors. Pure decision logic (gates, genre bucketing, the capped selection) lives in tested TypeScript under `src/lib/`; the scripts are thin I/O shells run through `tsx`.

**Tech Stack:** Node 22, TypeScript, `tsx` for script execution, Vitest, Next.js 16 (App Router), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-16-steam-native-rebuild-design.md`

## Global Constraints

- **Work on a branch.** `git checkout -b steam-native` before Task 1. Commits to `main` auto-deploy to Vercel; this rebuild must not land piecemeal in production. Merge only after Task 8.
- **Node 22 is required.** The shell defaults to Node 18 via Herd's nvm, which breaks Vitest 4 with `SyntaxError: ... does not provide an export named 'styleText'`. Prefix every command: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- **Zero budget.** No paid services, no new billable dependencies. Both data sources are keyless.
- **Read the Next.js docs before touching app code.** Per `AGENTS.md`: this Next.js version has breaking changes from training data. Consult `node_modules/next/dist/docs/`.
- **Eligibility constants** (from the spec, exact values): `MIN_REVIEWS = 2_000`, `MIN_POSITIVE_PCT = 75`, `FROM_YEAR = 2015`, `BOARD_CAP = 1_000`, `YEAR_FLOOR = 40`.
- **Steam request pacing: 250 ms.** Proven in production by `enrich-steam.mjs`. SteamSpy's `all` endpoint is capped at 1 request/minute.
- **Every Steam request sends** `cc=us&l=english` so `release_date.date` is consistently `"Mon DD, YYYY"`, and a `User-Agent` header.
- **The pipeline never overwrites good data.** On upstream failure exit 75 (`EX_TEMPFAIL`) leaving `src/data/games.json` untouched.

---

### Task 1: Pure catalogue logic

The gates, the year parser, the genre/mode mapping and the capped selection. All pure, all tested. Nothing here touches the network.

**Files:**
- Create: `src/lib/steam-catalog.ts`
- Create: `src/lib/steam-catalog.test.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json` (add `tsx` devDependency)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SteamSpyRow { appid: number; name: string; developer: string; positive: number; negative: number }`
  - `interface SteamDetail { type: string; name: string; releaseDate: string; comingSoon: boolean; genres: string[]; categories: string[]; developers: string[]; shortDescription: string; metacritic: number | null }`
  - `MIN_REVIEWS`, `MIN_POSITIVE_PCT`, `FROM_YEAR`, `BOARD_CAP`, `YEAR_FLOOR` — number constants
  - `totalReviews(r: SteamSpyRow): number`
  - `positivePct(r: SteamSpyRow): number`
  - `passesSentimentGate(r: SteamSpyRow): boolean`
  - `parseSteamYear(date: string, comingSoon: boolean): number | null`
  - `passesCatalogueGate(d: SteamDetail, currentYear: number): boolean`
  - `bestGenre(genreNames: string[]): string`
  - `modesFromCategories(categories: string[]): string[]`
  - `capWithYearFloor<T extends { year: number; composite: number }>(games: T[], cap: number, floor: number): T[]`

- [ ] **Step 1: Add the `@/` alias to Vitest and install `tsx`**

`vitest.config.ts` has no path alias, so any test importing `@/lib/...` fails to resolve. Task 6 needs it. Replace the file:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    // mirrors tsconfig.json "paths"
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
```

Then: `npm install --save-dev tsx@^4.23.12`

- [ ] **Step 2: Write the failing tests**

Create `src/lib/steam-catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  totalReviews,
  positivePct,
  passesSentimentGate,
  parseSteamYear,
  passesCatalogueGate,
  bestGenre,
  modesFromCategories,
  capWithYearFloor,
  MIN_REVIEWS,
  type SteamSpyRow,
  type SteamDetail,
} from "./steam-catalog";

const row = (over: Partial<SteamSpyRow> = {}): SteamSpyRow => ({
  appid: 1, name: "Game", developer: "Studio", positive: 9_500, negative: 500, ...over,
});

const detail = (over: Partial<SteamDetail> = {}): SteamDetail => ({
  type: "game", name: "Game", releaseDate: "Feb 24, 2022", comingSoon: false,
  genres: ["Action", "RPG"], categories: ["Single-player"], developers: ["Studio"],
  shortDescription: "A game.", metacritic: 94, ...over,
});

describe("sentiment gate", () => {
  it("counts reviews as positive plus negative", () => {
    expect(totalReviews(row({ positive: 30, negative: 12 }))).toBe(42);
  });

  it("reports 0% for a game with no reviews rather than dividing by zero", () => {
    expect(positivePct(row({ positive: 0, negative: 0 }))).toBe(0);
  });

  it("admits a game with a real, positive sample", () => {
    expect(passesSentimentGate(row())).toBe(true);
  });

  it("rejects a thin sample even when it is loved", () => {
    expect(passesSentimentGate(row({ positive: 99, negative: 1 }))).toBe(false);
  });

  it("rejects a large sample that is poorly rated", () => {
    expect(passesSentimentGate(row({ positive: 5_000, negative: 5_000 }))).toBe(false);
  });

  it("treats the review floor as inclusive", () => {
    expect(passesSentimentGate(row({ positive: MIN_REVIEWS, negative: 0 }))).toBe(true);
    expect(passesSentimentGate(row({ positive: MIN_REVIEWS - 1, negative: 0 }))).toBe(false);
  });
});

describe("parseSteamYear", () => {
  it("reads Steam's US English date format", () => {
    expect(parseSteamYear("Feb 24, 2022", false)).toBe(2022);
    expect(parseSteamYear("Mar 24, 2025", false)).toBe(2025);
  });

  it("accepts a bare year", () => {
    expect(parseSteamYear("2019", false)).toBe(2019);
  });

  // Steam uses "Q1 2026", "Coming soon", "To be announced" for unreleased titles.
  // Guessing a year for these is how unreleased games leaked onto the old board.
  it("returns null for anything it cannot read exactly", () => {
    expect(parseSteamYear("Q1 2026", false)).toBeNull();
    expect(parseSteamYear("Coming soon", false)).toBeNull();
    expect(parseSteamYear("", false)).toBeNull();
  });

  it("returns null when Steam says the game is not out yet", () => {
    expect(parseSteamYear("Feb 24, 2027", true)).toBeNull();
  });
});

describe("catalogue gate", () => {
  it("admits a released game inside the year range", () => {
    expect(passesCatalogueGate(detail(), 2026)).toBe(true);
  });

  it("rejects DLC, soundtracks and tools", () => {
    expect(passesCatalogueGate(detail({ type: "dlc" }), 2026)).toBe(false);
    expect(passesCatalogueGate(detail({ type: "music" }), 2026)).toBe(false);
  });

  it("rejects games released before the window", () => {
    expect(passesCatalogueGate(detail({ releaseDate: "Nov 18, 2014" }), 2026)).toBe(false);
  });

  it("rejects unreleased games", () => {
    expect(passesCatalogueGate(detail({ comingSoon: true }), 2026)).toBe(false);
  });

  it("rejects a release year in the future, which means bad data", () => {
    expect(passesCatalogueGate(detail({ releaseDate: "Jan 5, 2030" }), 2026)).toBe(false);
  });
});

describe("bestGenre", () => {
  it("picks the most specific bucket available", () => {
    expect(bestGenre(["Action", "RPG"])).toBe("RPG");
    expect(bestGenre(["Massively Multiplayer", "Action"])).toBe("MMO & Online");
  });

  it("falls back to Other for an unrecognised genre", () => {
    expect(bestGenre(["Utilities"])).toBe("Other");
    expect(bestGenre([])).toBe("Other");
  });
});

describe("modesFromCategories", () => {
  it("maps Steam's feature categories onto the board's four modes", () => {
    expect(modesFromCategories(["Single-player", "Online Co-op", "Online PvP"]).sort())
      .toEqual(["Co-op", "PvP", "Single-player"]);
  });

  it("treats MMO as live-service", () => {
    expect(modesFromCategories(["MMO"])).toContain("Live-service");
  });

  it("defaults to single-player when Steam lists nothing useful", () => {
    expect(modesFromCategories([])).toEqual(["Single-player"]);
  });
});

describe("capWithYearFloor", () => {
  const g = (year: number, composite: number) => ({ year, composite });

  it("keeps the highest scorers when no year needs protecting", () => {
    const out = capWithYearFloor([g(2020, 70), g(2020, 90), g(2020, 80)], 2, 0);
    expect(out.map((x) => x.composite)).toEqual([90, 80]);
  });

  // This is the regression guard for the bug that motivated the whole rebuild:
  // an older year dominating the cap and squeezing the current year off the board.
  it("guarantees the floor for a year that would otherwise be crowded out", () => {
    const older = Array.from({ length: 20 }, (_, i) => g(2022, 95 - i * 0.1));
    const newer = Array.from({ length: 5 }, (_, i) => g(2026, 70 - i));
    const out = capWithYearFloor([...older, ...newer], 10, 3);
    expect(out.filter((x) => x.year === 2026)).toHaveLength(3);
    expect(out).toHaveLength(10);
  });

  it("returns everything when the input is smaller than the cap", () => {
    expect(capWithYearFloor([g(2020, 90), g(2021, 80)], 100, 40)).toHaveLength(2);
  });

  it("refuses a floor that cannot fit inside the cap", () => {
    const games = [g(2020, 90), g(2021, 80), g(2022, 70)];
    expect(() => capWithYearFloor(games, 5, 40)).toThrow(/exceeds cap/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run src/lib/steam-catalog.test.ts`
Expected: FAIL — `Failed to resolve import "./steam-catalog"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/steam-catalog.ts`. The genre bucketing is ported from `scripts/fetch-rawg.mjs` unchanged, so the UI's existing genre filter keeps working.

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run src/lib/steam-catalog.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 6: Mutation-check the year floor**

Temporarily delete the reservation loop (`for (const list of byYear.values()) ...`) and re-run. Expected: *"guarantees the floor for a year that would otherwise be crowded out"* FAILS. Restore the line and confirm green again. A test that cannot fail is not a test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/steam-catalog.ts src/lib/steam-catalog.test.ts vitest.config.ts package.json package-lock.json
git commit -m "Add pure Steam catalogue logic: gates, year parsing, capped selection"
```

---

### Task 2: Stop thin samples scoring as certainties

Every 2025+ game has `metacritic: null`, which routes it through a branch that skips confidence entirely and publishes the raw Steam percentage. Fix that before generating new data, so the Task 5 cutover diff reflects final scoring.

**Files:**
- Modify: `src/lib/rank.ts:94-98` (`prior`), `src/lib/rank.ts:131-143` (the blend)
- Modify: `src/lib/rank.test.ts:61-66` (the `prior` test)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `prior(games: Game[]): number` — unchanged signature, changed meaning (averages the *player* signal, not Metacritic). `rank()` signature unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe("prior", ...)` block in `src/lib/rank.test.ts` with:

```ts
describe("prior", () => {
  it("averages the player signal across the board", () => {
    const p = prior([
      make({ steamPositive: 70, steamReviews: 10_000 }),
      make({ steamPositive: 90, steamReviews: 10_000 }),
    ]);
    expect(p).toBeCloseTo(80, 5);
  });

  it("falls back to 80 when no game carries a player signal", () => {
    expect(prior([make({ steamPositive: null, steamReviews: null })])).toBe(80);
  });
});
```

And add to `describe("rank — critic/player blend", ...)`:

```ts
  // Steam-era games mostly have no Metacritic score. Publishing their raw
  // review percentage let a 200-review game outrank The Witcher 3.
  it("pulls a thin players-only score toward the board prior", () => {
    const board: Game[] = [
      ...Array.from({ length: 9 }, (_, i) =>
        make({ title: `Solid ${i}`, metacritic: 85, steamPositive: 80, steamReviews: 200_000 })
      ),
      make({ title: "Thin", metacritic: null, steamPositive: 98, steamReviews: 200 }),
    ];
    const thin = rank(board).find((g) => g.title === "Thin")!;
    // prior = 81.8; confidence(200) ≈ 0.535 → 98·0.535 + 81.8·0.465 ≈ 90.5
    expect(thin.composite).toBeGreaterThan(88);
    expect(thin.composite).toBeLessThan(93);
  });

  it("leaves a players-only score alone once the sample is large", () => {
    const board: Game[] = [
      ...Array.from({ length: 9 }, (_, i) =>
        make({ title: `Solid ${i}`, metacritic: 85, steamPositive: 80, steamReviews: 200_000 })
      ),
      make({ title: "Thick", metacritic: null, steamPositive: 98, steamReviews: 200_000 }),
    ];
    expect(rank(board).find((g) => g.title === "Thick")!.composite).toBe(98);
  });
```

Delete the now-superseded test `"a game with no critic score rides on players alone"` (lines 109-112) — it asserts precisely the behaviour being removed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run src/lib/rank.test.ts`
Expected: FAIL — `prior` returns 88 (the Metacritic default in `make`) not 80, and `Thin` scores 98, not ~90.5.

- [ ] **Step 3: Rewrite `prior`**

In `src/lib/rank.ts`, replace the `prior` function:

```ts
// The board's centre of gravity on the player scale, used to shrink
// thin-sample scores. Player-scale rather than Metacritic-scale so both sides
// of the blend are measured in the same units.
export function prior(games: Game[]): number {
  const scores = games.map(playerSignal).filter((s) => s != null).map((s) => s!.score);
  if (!scores.length) return 80;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
```

`playerSignal` is declared above `prior` in the file, so no reordering is needed.

- [ ] **Step 4: Shrink the players-only branch**

In `rank()`, compute the prior once before the `map`:

```ts
export function rank(games: Game[], userWeight: number = DEFAULT_USER_WEIGHT): Ranked[] {
  const w = clamp(userWeight, 0, 1);
  const boardPrior = prior(games);
  return games
    .map((g) => {
```

Then replace the `crit == null` branch:

```ts
      } else if (crit == null) {
        // No critic score — the Steam era's normal case. Trust the player
        // score in proportion to its sample, and pull the rest toward the
        // board average. Publishing the raw percentage let a 200-review game
        // outscore a decade of classics.
        composite = ps!.score * conf + boardPrior * (1 - conf);
        effW = 1;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run`
Expected: PASS, all files.

- [ ] **Step 6: Mutation-check the shrinkage**

Temporarily restore `composite = ps!.score;` and re-run. Expected: *"pulls a thin players-only score toward the board prior"* FAILS with 98. Restore the shrinkage and confirm green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/rank.ts src/lib/rank.test.ts
git commit -m "Shrink thin players-only scores toward the board prior"
```

---

### Task 3: Steam and SteamSpy HTTP clients

Thin wrappers with retry and backoff. `fetch` and `sleep` are injected so the retry logic is testable without the network — this is where outage handling actually lives, and an untested retry loop is how the RAWG outage stayed ambiguous for weeks.

**Files:**
- Create: `scripts/lib/steam-api.ts`
- Create: `src/lib/steam-api.test.ts`

Note the test lives under `src/` because `vitest.config.ts` only includes `src/**/*.test.ts`; it imports across with a relative path.

**Interfaces:**
- Consumes: `SteamSpyRow`, `SteamDetail` from `src/lib/steam-catalog.ts` (Task 1).
- Produces:
  - `interface Deps { fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void>; attempts?: number; baseDelayMs?: number }`
  - `getJsonWithRetry(url: string, deps?: Deps): Promise<unknown>`
  - `steamSpyPage(page: number, deps?: Deps): Promise<SteamSpyRow[]>`
  - `appDetails(appid: number, deps?: Deps): Promise<SteamDetail | null>`
  - `appReviews(appid: number, deps?: Deps): Promise<{ totalPositive: number; totalReviews: number } | null>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/steam-api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  getJsonWithRetry,
  steamSpyPage,
  appDetails,
  appReviews,
} from "../../scripts/lib/steam-api";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => new Response("", { status: code });
const noSleep = () => Promise.resolve();

describe("getJsonWithRetry", () => {
  it("returns the parsed body on the first success", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ hello: "world" }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).resolves.toEqual({ hello: "world" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and succeeds", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok({ ok: true }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx and succeeds", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok({ ok: true }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).resolves.toEqual({ ok: true });
  });

  // A DNS failure or connection reset throws rather than returning a response.
  // Uncaught, it escapes as an opaque crash — the exact shape of the RAWG outage.
  it("retries a network-level throw", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(ok({ ok: true }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).resolves.toEqual({ ok: true });
  });

  it("does not retry a 404, which will never succeed", async () => {
    const fetcher = vi.fn().mockResolvedValue(status(404));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).rejects.toThrow(/404/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget and names the last failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(status(503));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep, attempts: 3 }))
      .rejects.toThrow(/after 3 attempts.*503/s);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe("steamSpyPage", () => {
  it("flattens the appid-keyed object into rows", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      "10": { appid: 10, name: "Counter-Strike", developer: "Valve", positive: 243818, negative: 6427 },
    }));
    const rows = await steamSpyPage(0, { fetcher, sleep: noSleep });
    expect(rows).toEqual([{ appid: 10, name: "Counter-Strike", developer: "Valve", positive: 243818, negative: 6427 }]);
  });

  it("requests the page it was asked for", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({}));
    await steamSpyPage(3, { fetcher, sleep: noSleep });
    expect(String(fetcher.mock.calls[0][0])).toContain("request=all&page=3");
  });
});

describe("appDetails", () => {
  it("flattens Steam's nested success envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      "1245620": {
        success: true,
        data: {
          type: "game", name: "ELDEN RING",
          release_date: { coming_soon: false, date: "Feb 24, 2022" },
          genres: [{ description: "Action" }, { description: "RPG" }],
          categories: [{ description: "Single-player" }],
          developers: ["FromSoftware, Inc."],
          short_description: "A vast world.",
          metacritic: { score: 94 },
        },
      },
    }));
    await expect(appDetails(1245620, { fetcher, sleep: noSleep })).resolves.toEqual({
      type: "game", name: "ELDEN RING", releaseDate: "Feb 24, 2022", comingSoon: false,
      genres: ["Action", "RPG"], categories: ["Single-player"],
      developers: ["FromSoftware, Inc."], shortDescription: "A vast world.", metacritic: 94,
    });
  });

  it("returns null metacritic when Steam has no score", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      "1": { success: true, data: { type: "game", name: "X", release_date: { coming_soon: false, date: "Jan 1, 2020" } } },
    }));
    const d = await appDetails(1, { fetcher, sleep: noSleep });
    expect(d?.metacritic).toBeNull();
    expect(d?.genres).toEqual([]);
  });

  // Steam returns {"999": {"success": false}} for delisted or region-locked apps.
  it("returns null for an app Steam refuses to describe", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ "999": { success: false } }));
    await expect(appDetails(999, { fetcher, sleep: noSleep })).resolves.toBeNull();
  });

  it("sends cc=us and l=english so the date format is predictable", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ "1": { success: false } }));
    await appDetails(1, { fetcher, sleep: noSleep });
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain("cc=us");
    expect(url).toContain("l=english");
  });
});

describe("appReviews", () => {
  it("reads the review summary", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      success: 1, query_summary: { total_positive: 9_500, total_reviews: 10_000 },
    }));
    await expect(appReviews(1, { fetcher, sleep: noSleep }))
      .resolves.toEqual({ totalPositive: 9_500, totalReviews: 10_000 });
  });

  it("returns null when Steam reports no summary", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ success: 0 }));
    await expect(appReviews(1, { fetcher, sleep: noSleep })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run src/lib/steam-api.test.ts`
Expected: FAIL — cannot resolve `../../scripts/lib/steam-api`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/steam-api.ts`:

```ts
// HTTP access to SteamSpy and Steam. `fetcher` and `sleep` are injectable so
// the retry logic is testable without the network.
import type { SteamSpyRow, SteamDetail } from "../../src/lib/steam-catalog";

export interface Deps {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  baseDelayMs?: number;
}

const UA = { "User-Agent": "game-ranker data build" };
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function getJsonWithRetry(url: string, deps: Deps = {}): Promise<unknown> {
  const { fetcher = fetch, sleep = defaultSleep, attempts = 4, baseDelayMs = 1_000 } = deps;
  let last = "no response";
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetcher(url, { headers: UA });
    } catch (err) {
      // DNS / connection reset / TLS — retryable, and the usual shape of an
      // upstream outage. Uncaught, it escapes as an opaque crash.
      const e = err as Error & { cause?: { code?: string } };
      last = `network error (${e.cause?.code ?? e.message})`;
      await sleep(baseDelayMs * (i + 1));
      continue;
    }
    if (res.ok) return res.json();
    last = `HTTP ${res.status}`;
    if (res.status !== 429 && res.status < 500) throw new Error(`${url} failed: ${last}`);
    await sleep(baseDelayMs * (i + 1));
  }
  throw new Error(`${url} unreachable after ${attempts} attempts (last: ${last})`);
}

export async function steamSpyPage(page: number, deps: Deps = {}): Promise<SteamSpyRow[]> {
  const body = (await getJsonWithRetry(
    `https://steamspy.com/api.php?request=all&page=${page}`,
    deps
  )) as Record<string, SteamSpyRow>;
  return Object.values(body).map((r) => ({
    appid: Number(r.appid),
    name: r.name,
    developer: r.developer,
    positive: Number(r.positive) || 0,
    negative: Number(r.negative) || 0,
  }));
}

interface RawDetail {
  type?: string;
  name?: string;
  release_date?: { coming_soon?: boolean; date?: string };
  genres?: { description: string }[];
  categories?: { description: string }[];
  developers?: string[];
  short_description?: string;
  metacritic?: { score?: number };
}

export async function appDetails(appid: number, deps: Deps = {}): Promise<SteamDetail | null> {
  const url =
    `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=english` +
    `&filters=basic,genres,categories,release_date,developers,metacritic`;
  const body = (await getJsonWithRetry(url, deps)) as Record<string, { success?: boolean; data?: RawDetail }>;
  const entry = body[String(appid)];
  if (!entry?.success || !entry.data) return null;
  const d = entry.data;
  return {
    type: d.type ?? "",
    name: d.name ?? "",
    releaseDate: d.release_date?.date ?? "",
    comingSoon: d.release_date?.coming_soon ?? false,
    genres: (d.genres ?? []).map((g) => g.description),
    categories: (d.categories ?? []).map((c) => c.description),
    developers: d.developers ?? [],
    shortDescription: d.short_description ?? "",
    metacritic: d.metacritic?.score ?? null,
  };
}

export async function appReviews(
  appid: number,
  deps: Deps = {}
): Promise<{ totalPositive: number; totalReviews: number } | null> {
  const body = (await getJsonWithRetry(
    `https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`,
    deps
  )) as { success?: number; query_summary?: { total_positive?: number; total_reviews?: number } };
  const s = body.query_summary;
  if (!body.success || !s) return null;
  return { totalPositive: s.total_positive ?? 0, totalReviews: s.total_reviews ?? 0 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run src/lib/steam-api.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Mutation-check the retry boundary**

Change `if (res.status !== 429 && res.status < 500)` to `if (false)`. Expected: *"does not retry a 404, which will never succeed"* FAILS. Restore and confirm green.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/steam-api.ts src/lib/steam-api.test.ts
git commit -m "Add SteamSpy and Steam HTTP clients with tested retry"
```

---

### Task 4: The build script

Wires Tasks 1 and 3 into the six-stage pipeline. Writes a **candidate** file, not the live dataset — the cutover is Task 5, after human review of the diff.

**Files:**
- Create: `scripts/fetch-steam.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: everything exported by `src/lib/steam-catalog.ts` and `scripts/lib/steam-api.ts`.
- Produces: `src/data/games.candidate.json` — an array matching the current `Game` shape, with `rawgSlug`/`rawgRating`/`rawgRatingsCount` omitted and `steamAppId` always a number.

- [ ] **Step 1: Add the npm scripts**

In `package.json`, replace the `data`, `enrich` and `refresh` entries with:

```json
    "data": "tsx scripts/fetch-steam.ts",
    "data:docs": "node scripts/parse-games.mjs",
```

Delete the `enrich` and `refresh` scripts — stage 6 absorbs the enricher.

- [ ] **Step 2: Write the script**

Create `scripts/fetch-steam.ts`:

```ts
// Builds the games board from Steam, in six stages:
//
//   1 discover      SteamSpy `all` pages -> ~10k appids with review counts
//   2 sentiment     keep games with a real, positive sample
//   3 detail        Steam appdetails -> type, release date, genres, Metacritic
//   4 catalogue     keep released PC games from 2015 on
//   5 rank + cap    top BOARD_CAP by composite, with a per-year floor
//   6 exact counts  Steam appreviews for the survivors
//
// Writes src/data/games.candidate.json. Promoting it to games.json is a
// separate, reviewed step.
//
//   npm run data
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  passesSentimentGate, passesCatalogueGate, parseSteamYear, bestGenre,
  modesFromCategories, capWithYearFloor, totalReviews, positivePct,
  BOARD_CAP, YEAR_FLOOR, type SteamSpyRow, type SteamDetail,
} from "../src/lib/steam-catalog";
import { steamSpyPage, appDetails, appReviews } from "./lib/steam-api";
import { rank, type Game } from "../src/lib/rank";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = join(ROOT, "src/data/games.json");
const OUT = join(ROOT, "src/data/games.candidate.json");

const SPY_PAGES = 10;            // ~10,000 games by ownership
const SPY_SPACING_MS = 62_000;   // SteamSpy caps `all` at 1 request/minute
const STEAM_SPACING_MS = 250;    // proven in production by the old enricher
const BOARD_FLOOR = 0.8;         // refuse to write a board this much smaller than the live one

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CURRENT_YEAR = new Date().getFullYear();

// Probe both upstreams before a ~30-minute run, and name which one is down.
// They fail independently; conflating them is what made the RAWG outage
// ambiguous for weeks.
async function preflight() {
  try {
    await steamSpyPage(0);
  } catch (err) {
    console.error(`\nSteamSpy preflight failed: ${(err as Error).message}`);
    console.error("SteamSpy is a third-party service. Nothing is wrong with this repo.");
    console.error("If this persists for weeks, the discovery source needs replacing.");
    console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
    process.exit(75);
  }
  try {
    const d = await appDetails(1245620); // ELDEN RING
    if (!d) throw new Error("appdetails returned no data for a known-good appid");
  } catch (err) {
    console.error(`\nSteam preflight failed: ${(err as Error).message}`);
    console.error("Steam's store API is not answering. Nothing is wrong with this repo.");
    console.error("\nsrc/data/games.json is untouched; the live site keeps its last good data.\n");
    process.exit(75);
  }
}

async function main() {
  await preflight();

  // --- 1. discover ---------------------------------------------------------
  const candidates = new Map<number, SteamSpyRow>();
  for (let page = 0; page < SPY_PAGES; page++) {
    if (page > 0) await sleep(SPY_SPACING_MS);
    const rows = await steamSpyPage(page);
    for (const r of rows) candidates.set(r.appid, r);
    console.log(`  steamspy page ${page}: ${rows.length} rows (${candidates.size} unique)`);
  }

  // --- 2. sentiment gate ---------------------------------------------------
  const gated = [...candidates.values()].filter(passesSentimentGate);
  console.log(`\nsentiment gate: ${gated.length}/${candidates.size} kept`);

  // --- 3 + 4. detail and catalogue gate ------------------------------------
  const kept: { row: SteamSpyRow; detail: SteamDetail; year: number }[] = [];
  let done = 0;
  for (const row of gated) {
    await sleep(STEAM_SPACING_MS);
    let detail: SteamDetail | null = null;
    try {
      detail = await appDetails(row.appid);
    } catch (err) {
      console.warn(`  ${row.appid} detail failed — ${(err as Error).message}`);
    }
    if (detail && passesCatalogueGate(detail, CURRENT_YEAR)) {
      kept.push({ row, detail, year: parseSteamYear(detail.releaseDate, detail.comingSoon)! });
    }
    if (++done % 250 === 0) console.log(`  detail ${done}/${gated.length} (${kept.length} kept)`);
  }
  console.log(`\ncatalogue gate: ${kept.length}/${gated.length} kept`);

  // --- 5. rank and cap -----------------------------------------------------
  const provisional: Game[] = kept.map(({ row, detail, year }) => ({
    title: detail.name || row.name,
    year,
    developer: detail.developers[0] ?? row.developer ?? "—",
    genre: bestGenre(detail.genres),
    genreDetail: detail.genres.join(", ") || "—",
    platforms: ["PC"],
    metacritic: detail.metacritic,
    indie: detail.genres.some((g) => /indie/i.test(g)),
    modes: modesFromCategories(detail.categories),
    note: detail.shortDescription,
    steamAppId: row.appid,
    steamPositive: positivePct(row),
    steamReviews: totalReviews(row),
  })) as Game[];

  const scored = rank(provisional);
  const selected = capWithYearFloor(scored, BOARD_CAP, YEAR_FLOOR);
  console.log(`\ncap: ${selected.length} of ${scored.length} selected`);

  // --- 6. exact sentiment --------------------------------------------------
  const final: Game[] = [];
  done = 0;
  for (const g of selected) {
    await sleep(STEAM_SPACING_MS);
    let exact: { totalPositive: number; totalReviews: number } | null = null;
    try {
      exact = await appReviews(g.steamAppId!);
    } catch (err) {
      console.warn(`  ${g.steamAppId} reviews failed — ${(err as Error).message}`);
    }
    final.push({
      title: g.title, year: g.year, developer: g.developer, genre: g.genre,
      genreDetail: g.genreDetail, platforms: g.platforms, metacritic: g.metacritic,
      indie: g.indie, modes: g.modes, note: g.note, steamAppId: g.steamAppId,
      steamPositive: exact && exact.totalReviews > 0
        ? (exact.totalPositive / exact.totalReviews) * 100
        : g.steamPositive,
      steamReviews: exact?.totalReviews ?? g.steamReviews,
    } as Game);
    if (++done % 250 === 0) console.log(`  reviews ${done}/${selected.length}`);
  }

  // A partial run must never gut the board.
  if (existsSync(LIVE)) {
    const liveCount = (JSON.parse(readFileSync(LIVE, "utf8")) as unknown[]).length;
    if (final.length < liveCount * BOARD_FLOOR) {
      console.error(`\nOnly ${final.length} games, under ${Math.round(liveCount * BOARD_FLOOR)} (${BOARD_FLOOR * 100}% of the live ${liveCount}).`);
      console.error("Refusing to write. src/data/games.json is untouched.\n");
      process.exit(75);
    }
  }

  writeFileSync(OUT, JSON.stringify(final, null, 2) + "\n");

  const byYear: Record<number, number> = {};
  for (const g of final) byYear[g.year] = (byYear[g.year] ?? 0) + 1;
  console.log(`\nwrote ${OUT}`);
  console.log(`games: ${final.length}`);
  console.log(`by year: ${JSON.stringify(byYear)}`);
  console.log(`with metacritic: ${final.filter((g) => g.metacritic != null).length}`);
}

main().catch((err) => {
  console.error(`\nBuild failed: ${(err as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 3: Typecheck**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx tsc --noEmit`
Expected: PASS. The `as Game[]` casts are deliberate — `Game` still carries the RAWG fields until Task 5, and they are removed there.

- [ ] **Step 4: Run the real build**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npm run data 2>&1 | tee /tmp/fetch-steam.log`

This takes roughly 30 minutes: ~10 min of SteamSpy pacing, ~15 min of detail calls, ~5 min of review calls. Launch it detached (`nohup ... &`) if running as a subagent — a background job dies with the turn otherwise. Check for the process, do not assume it survived.

Expected: `src/data/games.candidate.json` exists, and the by-year line shows a substantial count for the current year — the whole point of the rebuild.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-steam.ts package.json src/data/games.candidate.json
git commit -m "Add the Steam-native build script"
```

---

### Task 5: Cutover

Promote the candidate to the live dataset, tighten `Game` to the Steam-only shape, and delete everything RAWG. **This task has a human review gate in the middle — do not skip it.**

**Files:**
- Modify: `src/data/games.json` (replaced)
- Delete: `src/data/games.candidate.json`
- Modify: `src/lib/rank.ts` (the `Game` interface, `rawgToPercent`, `playerSignal`, the `ps == null` branch)
- Modify: `src/lib/rank.test.ts` (the `make` factory)
- Delete: `scripts/fetch-rawg.mjs`, `scripts/enrich-steam.mjs`, `scripts/parse-games.mjs`
- Modify: `package.json` (drop `data:docs`)

**Interfaces:**
- Consumes: `src/data/games.candidate.json` from Task 4.
- Produces: `Game` without `rawgSlug`, `rawgRating`, `rawgRatingsCount`, and with `steamAppId: number`, `steamPositive: number`, `steamReviews: number` all required.

- [ ] **Step 1: Diff the boards and STOP for review**

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node -e '
const old=require("./src/data/games.json"), neu=require("./src/data/games.candidate.json");
const oldT=new Set(old.map(g=>g.title)), newT=new Set(neu.map(g=>g.title));
console.log(`old ${old.length} -> new ${neu.length}`);
const byYear=o=>{const m={};for(const g of o)m[g.year]=(m[g.year]||0)+1;return m};
console.log("old by year:",JSON.stringify(byYear(old)));
console.log("new by year:",JSON.stringify(byYear(neu)));
console.log("\nLEFT (first 40):",[...oldT].filter(t=>!newT.has(t)).slice(0,40).join(" | "));
console.log("\nARRIVED (first 40):",[...newT].filter(t=>!oldT.has(t)).slice(0,40).join(" | "));
'
```

Then rank both and compare the top 50, and check the tier distribution:

```bash
npx tsx -e '
import {rank} from "./src/lib/rank";
import neu from "./src/data/games.candidate.json";
const r = rank(neu as never);
console.log("top 20:"); r.slice(0,20).forEach((g,i)=>console.log(`  ${i+1}. ${g.composite} ${g.tier} ${g.title} (${g.year})`));
const tiers: Record<string,number> = {};
for (const g of r) tiers[g.tier] = (tiers[g.tier]??0)+1;
console.log("tiers:", JSON.stringify(tiers), " S share:", (100*(tiers.S??0)/r.length).toFixed(1)+"%");
'
```

**Present all of this to the user and wait for approval before continuing.** Two things need a human decision:

1. Whether the games that left and arrived look right.
2. Whether `tierOf()`'s cutoffs still hold. They were calibrated so S is roughly the top 8% against the RAWG+Steam distribution. If the S share has drifted far from that, propose new cutoffs and get them approved — do not silently recalibrate.

- [ ] **Step 2: Promote the candidate**

```bash
mv src/data/games.candidate.json src/data/games.json
```

- [ ] **Step 3: Tighten the `Game` interface**

In `src/lib/rank.ts`, replace the interface fields. Remove `rawgRating`, `rawgRatingsCount`, `rawgSlug`; make the Steam fields required:

```ts
export interface Game {
  title: string;
  year: number;
  developer: string;
  genre: string; // canonical bucket (used by table + filter)
  genreDetail: string; // original Steam genres (shown in the per-game detail)
  platforms: "PC"[];
  metacritic: number | null; // Metacritic aggregate as reported by Steam, 0–100
  indie: boolean;
  modes: string[];
  note: string; // short blurb
  steamAppId: number;
  steamPositive: number; // % of Steam reviews that are positive, 0–100
  steamReviews: number; // Steam review count (sample size)
}
```

- [ ] **Step 4: Delete the RAWG fallback**

In `src/lib/rank.ts`:

- Delete `rawgToPercent` entirely (function and its doc comment).
- Simplify `playerSignal` — every game now carries Steam data by construction:

```ts
function playerSignal(g: Game): { score: number; source: PlayerSource; sample: number } | null {
  if (g.steamReviews > 0) {
    return { score: g.steamPositive, source: "steam", sample: g.steamReviews };
  }
  return null;
}
```

- Narrow `PlayerSource`: `export type PlayerSource = "steam";`
- Delete the `} else if (ps == null) {` branch in `rank()` — unreachable now. Keep the `crit == null && ps == null` guard, which still protects against a malformed dataset.

- [ ] **Step 5: Update the test factory and delete RAWG tests**

In `src/lib/rank.test.ts`, replace `make`:

```ts
const make = (over: Partial<Game>): Game => ({
  title: "Game",
  year: 2020,
  developer: "Studio",
  genre: "RPG",
  genreDetail: "RPG",
  platforms: ["PC"],
  metacritic: 88,
  indie: false,
  modes: ["Single-player"],
  note: "",
  steamAppId: 1,
  steamPositive: 0,
  steamReviews: 0,
  ...over,
});
```

Delete the test `"falls back to the RAWG community rating (calibrated) when there is no Steam data"` (it tests deleted code). Change `"a game with no player signal keeps its critic score at any weight"` to use `steamReviews: 0`:

```ts
  it("a game with no player signal keeps its critic score at any weight", () => {
    const g = make({ metacritic: 91, steamPositive: 0, steamReviews: 0 });
    expect(rank([g], 1)[0].composite).toBe(91);
    expect(rank([g], 0.5)[0].composite).toBe(91);
  });
```

`Game.platforms` is now `"PC"[]`, so the `applyFilters` fixtures no longer typecheck. Change all three to `platforms: ["PC"]`, and delete the test `"filters by platform checkboxes"` — with every fixture on PC it can no longer distinguish anything. `Filters` itself still carries `platforms` until Task 7; leave `baseFilters` untouched here.

- [ ] **Step 6: Delete the RAWG scripts**

```bash
git rm scripts/fetch-rawg.mjs scripts/enrich-steam.mjs scripts/parse-games.mjs
```

Remove the `"data:docs"` line from `package.json`.

- [ ] **Step 7: Verify**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Cut over to the Steam-native dataset and delete the RAWG pipeline"
```

---

### Task 6: Dataset regression tests

The guard that would have caught this bug in July instead of August.

**Files:**
- Create: `src/data/games.test.ts`

**Interfaces:**
- Consumes: `Game` from `src/lib/rank.ts` (Task 5), `YEAR_FLOOR`/`FROM_YEAR`/`BOARD_CAP` from `src/lib/steam-catalog.ts` (Task 1).
- Produces: nothing.

- [ ] **Step 1: Write the tests**

Create `src/data/games.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import gamesData from "./games.json";
import { CURRENT_YEAR, type Game } from "@/lib/rank";
import { FROM_YEAR, YEAR_FLOOR, BOARD_CAP, MIN_REVIEWS } from "@/lib/steam-catalog";

const games = gamesData as Game[];

describe("games.json", () => {
  it("is within the board cap and not empty", () => {
    expect(games.length).toBeGreaterThan(BOARD_CAP * 0.5);
    expect(games.length).toBeLessThanOrEqual(BOARD_CAP);
  });

  it("has no duplicate Steam app ids", () => {
    expect(new Set(games.map((g) => g.steamAppId)).size).toBe(games.length);
  });

  // The gate runs on SteamSpy's approximate counts; stage 6 then replaces them
  // with Steam's exact ones, which can land slightly lower. The spec accepts
  // that, so this asserts the band rather than the bare threshold.
  it("gives every game a usable player signal", () => {
    for (const g of games) {
      expect(g.steamReviews, g.title).toBeGreaterThanOrEqual(MIN_REVIEWS * 0.8);
      expect(g.steamPositive, g.title).toBeGreaterThan(0);
      expect(g.steamPositive, g.title).toBeLessThanOrEqual(100);
    }
  });

  it("lists every game on PC and nothing else", () => {
    for (const g of games) expect(g.platforms, g.title).toEqual(["PC"]);
  });

  // THE regression guard. The RAWG pipeline shipped 6 games for 2026 against
  // 140 for 2022, because its cap filled with older titles ordered by
  // cumulative popularity. This assertion fails the build when that recurs.
  it("carries at least the year floor for every year in range", () => {
    const byYear = new Map<number, number>();
    for (const g of games) byYear.set(g.year, (byYear.get(g.year) ?? 0) + 1);
    for (let y = FROM_YEAR; y <= CURRENT_YEAR; y++) {
      expect(byYear.get(y) ?? 0, `release year ${y}`).toBeGreaterThanOrEqual(YEAR_FLOOR);
    }
  });

  it("holds no unreleased or out-of-range games", () => {
    for (const g of games) {
      expect(g.year, g.title).toBeGreaterThanOrEqual(FROM_YEAR);
      expect(g.year, g.title).toBeLessThanOrEqual(CURRENT_YEAR);
    }
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run src/data/games.test.ts`
Expected: PASS. **If the year-floor test fails, stop and report it** — it means the pipeline is not delivering the coverage the rebuild exists to provide, and that is a real finding, not a test to relax.

- [ ] **Step 3: Verify the guard can fail**

```bash
node -e '
const fs=require("fs"); const p="src/data/games.json";
const g=JSON.parse(fs.readFileSync(p)); fs.writeFileSync("/tmp/games.bak",JSON.stringify(g));
const cy=new Date().getFullYear();
fs.writeFileSync(p, JSON.stringify(g.filter(x=>x.year!==cy||Math.random()<0.05), null, 2)+"\n");
'
npx vitest run src/data/games.test.ts   # expect the year-floor test to FAIL
cp /tmp/games.bak src/data/games.json && npx prettier --write src/data/games.json 2>/dev/null || true
git checkout src/data/games.json
npx vitest run src/data/games.test.ts   # expect PASS again
```

- [ ] **Step 4: Commit**

```bash
git add src/data/games.test.ts
git commit -m "Guard dataset coverage: fail the build when a release year thins out"
```

---

### Task 7: PC-only application

**Files:**
- Modify: `src/lib/rank.ts` (`Filters`, `applyFilters`)
- Modify: `src/lib/rank.test.ts` (`baseFilters`, platform tests)
- Modify: `src/app/page.tsx:30,64,86-87,106,273,276,382-390,537,586`
- Modify: `src/lib/best.ts:32,48,59,70`
- Modify: `src/app/layout.tsx:17,19`
- Modify: `src/app/best/[slug]/page.tsx:97`
- Modify: `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: `Game` from Task 5.
- Produces: `Filters` without the `platforms` key; `steamStoreUrl(appId: number): string` exported from `src/lib/rank.ts`.

**Read `node_modules/next/dist/docs/` before editing app code** — this Next.js version differs from training data.

- [ ] **Step 1: Write the failing tests**

In `src/lib/rank.test.ts`, remove the `platforms` key from `baseFilters` (the fixtures and the platform-filter test were already handled in Task 5). Add:

```ts
describe("steamStoreUrl", () => {
  it("builds a Steam store link from the app id", () => {
    expect(steamStoreUrl(1245620)).toBe("https://store.steampowered.com/app/1245620/");
  });
});
```

Add `steamStoreUrl` to the import list at the top of the file.

- [ ] **Step 2: Run to verify failure**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run src/lib/rank.test.ts`
Expected: FAIL — `steamStoreUrl` is not exported.

- [ ] **Step 3: Update `rank.ts`**

Remove `platforms` from `Filters` and from `applyFilters` (delete the line `if (!g.platforms.some((p) => f.platforms[p])) return false;`). Add:

```ts
export const steamStoreUrl = (appId: number): string =>
  `https://store.steampowered.com/app/${appId}/`;
```

- [ ] **Step 4: Run to verify pass**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Update the UI**

In `src/app/page.tsx`:
- `DEFAULT_FILTERS` (line 30): delete the `platforms` key.
- Line 64: delete the `plats` line and any use of it in URL-state serialisation.
- Lines 86-87: delete the `pc`/`ps` query-param parsing.
- Line 106: `const playerLabel = g.playerSource === "steam" ? "Steam" : "—";`
- Line 273: change the blurb to `The best PC games, 2015→today — {GAMES.length} titles discovered automatically from Steam,`
- Line 276: `filter by year and` (drop "platform").
- Lines 382-390: delete the whole platform checkbox group.
- Line 537: replace the platform badge list with a Steam store link:

```tsx
<a
  href={steamStoreUrl(g.steamAppId)}
  target="_blank"
  rel="noopener noreferrer"
  className="text-[#7d8590] hover:text-[#e6edf3]"
>
  steam↗
</a>
```

- Line 586: delete the `PlatformBadge` component.
- Import `steamStoreUrl` from `@/lib/rank`.

In `src/app/best/[slug]/page.tsx:97`: replace the platform badge map with the same Steam link.

In `src/lib/best.ts`: delete `platforms` from `baseFilter()`; change the three blurbs to say "PC games" rather than "PC and PlayStation games".

In `src/app/layout.tsx`: title → `"game-ranker — best PC games 2015→today"`; description → `"An interactive, algorithmically-ranked leaderboard of the best PC games. Filter by year and genre; critic and player scores merged with a transparent, confidence-weighted model."`

- [ ] **Step 6: Update the docs**

In `README.md`, replace the RAWG description with the Steam pipeline: the six stages, the eligibility rule, the constants, and `npm run data` as the only build command (there is no separate enrich step). In `AGENTS.md`, update the game-ranker section the same way. Remove all references to `RAWG_API_KEY`, `npm run enrich`, `npm run refresh` and `npm run data:docs`.

- [ ] **Step 7: Verify**

Run: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH" && npx vitest run && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. Then `npm run dev` and confirm by eye: no platform filter, Steam links resolve, the year filter still works, `/best/2026` renders.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Make the board PC-only and link out to Steam"
```

---

### Task 8: Weekly workflow

**Files:**
- Modify: `.github/workflows/refresh.yml`

**Interfaces:**
- Consumes: `npm run data` from Task 4.
- Produces: nothing.

- [ ] **Step 1: Rewrite the build steps**

Replace the three steps `Discover games from RAWG`, `Add Steam player sentiment` and `Sanity-check the dataset` with:

```yaml
      - name: Rebuild the board from Steam
        run: npm run data

      - name: Promote the candidate
        run: mv src/data/games.candidate.json src/data/games.json

      - name: Sanity-check the dataset
        run: npm test
```

Remove the `RAWG_API_KEY` env block entirely — there is no key any more.

Add a job timeout under `runs-on`, since the run is now ~30 minutes and an unbounded job can hang for six hours:

```yaml
    timeout-minutes: 90
```

- [ ] **Step 2: Alert on cancellation as well as failure**

Change the alert step's condition:

```yaml
      - name: Raise an alert issue on failure
        if: failure() || cancelled()
```

A job that exceeds `timeout-minutes` is **cancelled, not failed**, so `failure()` alone would skip the alert — recreating the silent failure this alerting exists to prevent.

- [ ] **Step 3: Update the alert body**

In the alert step, change the diagnostic line to name both upstreams:

```
          Check the log for the \`SteamSpy preflight failed:\` or \`Steam preflight failed:\` line — it names which upstream is down.
```

And update the commit message in the `Commit if the dataset changed` step to `"chore: weekly Steam refresh"`.

- [ ] **Step 4: Validate the YAML**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/refresh.yml')); print('YAML OK')"
grep -n "failure() || cancelled()" .github/workflows/refresh.yml
grep -c "RAWG" .github/workflows/refresh.yml || echo "no RAWG references — good"
```

Expected: `YAML OK`, the cancellation condition present, zero RAWG references.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/refresh.yml
git commit -m "Point the weekly refresh at the Steam pipeline"
```

- [ ] **Step 6: Merge and watch**

```bash
git checkout main && git merge --no-ff steam-native && git push
gh workflow run refresh.yml
gh run watch "$(gh run list --workflow=refresh.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Confirm the alert issue "🔴 Weekly game refresh is failing" auto-closes, and that games.hendragunawan.com shows the new board with a healthy count for the current year.

---

## Notes for the executor

- **The Task 5 review gate is not optional.** A silent whole-board replacement is the one outcome this plan is structured to prevent.
- **If the Task 6 year-floor test fails, that is a finding, not a flaky test.** Report it; do not lower the floor to make it pass.
- **Genre granularity degrades.** Steam's `genres` are coarse (Action, RPG, Indie, Simulation) and carry no Soulslike, Horror, Roguelike, Metroidvania, Shooter, Puzzle or Stealth values. Those buckets will empty out even though `canonicalGenre` still knows them. This is a known, accepted consequence, not a bug to fix mid-plan.
