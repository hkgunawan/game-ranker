import { describe, expect, it } from "vitest";
import { rank, applyFilters, tierOf, prior, isProvisional, MODES, type Game, type Filters } from "./rank";

const make = (over: Partial<Game>): Game => ({
  title: "Game",
  year: 2020,
  developer: "Studio",
  genre: "RPG",
  genreDetail: "JRPG",
  platforms: ["PC"],
  pcScore: 88,
  psScore: null,
  metacritic: null,
  awards: [],
  indie: false,
  modes: ["Single-player"],
  note: "",
  ...over,
});

const baseFilters: Filters = {
  yearMin: 2015,
  yearMax: 2026,
  platforms: { PC: true, PlayStation: true },
  modes: { "Single-player": true, "Co-op": true, PvP: true, "Live-service": true },
  genre: "",
  search: "",
  indieOnly: false,
};

describe("tierOf", () => {
  it("maps scores to tiers", () => {
    expect(tierOf(95)).toBe("S");
    expect(tierOf(90)).toBe("A");
    expect(tierOf(86)).toBe("A−");
    expect(tierOf(83)).toBe("B");
    expect(tierOf(70)).toBe("C");
  });
});

describe("isProvisional", () => {
  it("flags 2025+ releases", () => {
    expect(isProvisional(make({ year: 2025 }))).toBe(true);
    expect(isProvisional(make({ year: 2024 }))).toBe(false);
  });
});

describe("prior", () => {
  it("averages every available editorial score", () => {
    const p = prior([make({ pcScore: 80 }), make({ pcScore: 90, psScore: 100 })]);
    expect(p).toBeCloseTo((80 + 90 + 100) / 3, 5);
  });
});

describe("rank", () => {
  it("sorts by composite descending", () => {
    const out = rank([make({ title: "Low", pcScore: 80 }), make({ title: "High", pcScore: 98 })]);
    expect(out[0].title).toBe("High");
    expect(out[0].composite).toBeGreaterThan(out[1].composite);
  });

  it("leaves a settled score essentially unchanged (trusts the editorial score)", () => {
    // a 6-year-old, high-confidence title should sit within ~0.5 of its raw score
    const out = rank([
      make({ title: "Settled", pcScore: 95, year: 2018 }),
      make({ title: "Anchor", pcScore: 88, year: 2018 }),
    ]);
    const settled = out.find((g) => g.title === "Settled")!;
    expect(Math.abs(settled.composite - settled.rawMean)).toBeLessThan(0.6);
  });

  it("shrinks a thin provisional score toward the mean more than a settled one", () => {
    const both: Game["platforms"] = ["PC", "PlayStation"];
    const games = [
      make({ title: "Anchor", pcScore: 88, psScore: 88, year: 2016, platforms: both }),
      make({ title: "Settled", pcScore: 95, psScore: 95, year: 2017, platforms: both }),
      make({ title: "Fresh", pcScore: 95, year: 2026 }),
    ];
    const out = rank(games);
    const settled = out.find((g) => g.title === "Settled")!;
    const fresh = out.find((g) => g.title === "Fresh")!;
    expect(settled.rawMean).toBe(fresh.rawMean); // same raw input
    expect(settled.composite).toBeGreaterThan(fresh.composite); // thin evidence shrinks more
  });

  it("does not penalize a single-platform exclusive vs an equal cross-platform title", () => {
    // an above-average exclusive stays within a hair of its cross-platform equal —
    // no additive cross-platform bonus, so exclusivity barely matters
    const both: Game["platforms"] = ["PC", "PlayStation"];
    const games = [
      make({ title: "Anchor", pcScore: 80, year: 2016 }),
      make({ title: "Both", pcScore: 95, psScore: 95, year: 2018, platforms: both }),
      make({ title: "Exclusive", pcScore: 95, year: 2018 }),
    ];
    const out = rank(games);
    const both2 = out.find((g) => g.title === "Both")!;
    const excl = out.find((g) => g.title === "Exclusive")!;
    expect(both2.composite).toBeGreaterThanOrEqual(excl.composite); // corroboration only via confidence
    expect(both2.composite - excl.composite).toBeLessThan(0.5); // but the gap is tiny
  });
});

describe("applyFilters", () => {
  const games = [
    make({ title: "PC RPG 2016", year: 2016, platforms: ["PC"], genre: "RPG", modes: ["Single-player"] }),
    make({ title: "PS Action 2022", year: 2022, platforms: ["PlayStation"], genre: "Action & Adventure", modes: ["Single-player"] }),
    make({ title: "Both 2020", year: 2020, platforms: ["PC", "PlayStation"], genre: "RPG", indie: true, modes: ["Co-op", "PvP"] }),
  ];

  it("filters by year range", () => {
    expect(applyFilters(games, { ...baseFilters, yearMin: 2021 }).map((g) => g.title)).toEqual(["PS Action 2022"]);
  });

  it("filters by platform checkboxes", () => {
    const out = applyFilters(games, { ...baseFilters, platforms: { PC: false, PlayStation: true } });
    expect(out.map((g) => g.title).sort()).toEqual(["Both 2020", "PS Action 2022"]);
  });

  it("filters by mode (game passes if it has any selected mode)", () => {
    const out = applyFilters(games, {
      ...baseFilters,
      modes: { "Single-player": false, "Co-op": true, PvP: false, "Live-service": false },
    });
    expect(out.map((g) => g.title)).toEqual(["Both 2020"]);
  });

  it("filters by genre, search, and indie", () => {
    expect(applyFilters(games, { ...baseFilters, genre: "Action & Adventure" })).toHaveLength(1);
    expect(applyFilters(games, { ...baseFilters, search: "rpg 2016" })).toHaveLength(1);
    expect(applyFilters(games, { ...baseFilters, indieOnly: true })).toHaveLength(1);
  });

  it("exposes the four canonical modes", () => {
    expect(MODES).toEqual(["Single-player", "Co-op", "PvP", "Live-service"]);
  });
});
