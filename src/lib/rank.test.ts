import { describe, expect, it } from "vitest";
import {
  rank,
  applyFilters,
  tierOf,
  prior,
  isProvisional,
  reviewConfidence,
  MODES,
  type Game,
  type Filters,
} from "./rank";

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
  steamAppId: null,
  steamPositive: null,
  steamReviews: null,
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

describe("reviewConfidence", () => {
  it("is 0 without Steam data and ~1 with many reviews", () => {
    expect(reviewConfidence(make({ steamPositive: null, steamReviews: null }))).toBe(0);
    expect(reviewConfidence(make({ steamPositive: 90, steamReviews: 1_000_000 }))).toBe(1);
  });
});

describe("rank — critic/player blend", () => {
  it("sorts by composite descending", () => {
    const out = rank([make({ title: "Low", pcScore: 80 }), make({ title: "High", pcScore: 98 })]);
    expect(out[0].title).toBe("High");
    expect(out[0].composite).toBeGreaterThan(out[1].composite);
  });

  it("at players=0, the composite is exactly the editorial score", () => {
    const g = make({ pcScore: 90, steamPositive: 60, steamReviews: 100_000 });
    expect(rank([g], 0)[0].composite).toBe(90);
  });

  it("at players=1, a low player score drags a critic favourite down", () => {
    const g = make({ pcScore: 90, steamPositive: 60, steamReviews: 100_000 });
    const r = rank([g], 1)[0];
    expect(r.userScore).toBe(60);
    expect(r.composite).toBeLessThan(65); // pulled toward the 60% player score
  });

  it("a game with no Steam data keeps its editorial score at any weight", () => {
    const g = make({ pcScore: 91, steamPositive: null, steamReviews: null });
    expect(rank([g], 1)[0].composite).toBe(91);
    expect(rank([g], 0.5)[0].composite).toBe(91);
  });

  it("more reviews give player sentiment more pull", () => {
    const games = [
      make({ title: "Few", pcScore: 90, steamPositive: 60, steamReviews: 50 }),
      make({ title: "Many", pcScore: 90, steamPositive: 60, steamReviews: 500_000 }),
    ];
    const out = rank(games, 1);
    const few = out.find((g) => g.title === "Few")!;
    const many = out.find((g) => g.title === "Many")!;
    expect(many.composite).toBeLessThan(few.composite); // big sample -> closer to the 60% score
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
