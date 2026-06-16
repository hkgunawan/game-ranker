import { describe, expect, it } from "vitest";
import { rank, applyFilters, tierOf, prior, isProvisional, type Game } from "./rank";

const make = (over: Partial<Game>): Game => ({
  title: "Game",
  year: 2020,
  developer: "Studio",
  genre: "RPG",
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

  it("shrinks a thin provisional score toward the mean more than a settled one", () => {
    // identical raw score, different evidence: old cross-platform vs new single-platform
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

  it("gives cross-platform titles a corroboration edge over a single-platform equal", () => {
    const games = [
      make({ title: "Both", pcScore: 90, psScore: 90, year: 2018, platforms: ["PC", "PlayStation"] }),
      make({ title: "One", pcScore: 90, year: 2018 }),
    ];
    const out = rank(games);
    expect(out.find((g) => g.title === "Both")!.composite).toBeGreaterThan(
      out.find((g) => g.title === "One")!.composite
    );
  });
});

describe("applyFilters", () => {
  const games = [
    make({ title: "PC RPG 2016", year: 2016, platforms: ["PC"], genre: "RPG" }),
    make({ title: "PS Action 2022", year: 2022, platforms: ["PlayStation"], genre: "Action" }),
    make({ title: "Both 2020", year: 2020, platforms: ["PC", "PlayStation"], genre: "RPG", indie: true }),
  ];
  const base = {
    yearMin: 2015,
    yearMax: 2026,
    platforms: { PC: true, PlayStation: true },
    genre: "",
    search: "",
    indieOnly: false,
  };

  it("filters by year range", () => {
    expect(applyFilters(games, { ...base, yearMin: 2021 }).map((g) => g.title)).toEqual(["PS Action 2022"]);
  });

  it("filters by platform checkboxes", () => {
    const out = applyFilters(games, { ...base, platforms: { PC: false, PlayStation: true } });
    expect(out.map((g) => g.title).sort()).toEqual(["Both 2020", "PS Action 2022"]);
  });

  it("filters by genre, search, and indie", () => {
    expect(applyFilters(games, { ...base, genre: "Action" })).toHaveLength(1);
    expect(applyFilters(games, { ...base, search: "rpg 2016" })).toHaveLength(1);
    expect(applyFilters(games, { ...base, indieOnly: true })).toHaveLength(1);
  });
});
