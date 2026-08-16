import { describe, expect, it } from "vitest";
import {
  rank,
  applyFilters,
  tierOf,
  prior,
  isProvisional,
  confidenceOf,
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
  metacritic: 88,
  rawgRating: null,
  rawgRatingsCount: null,
  indie: false,
  modes: ["Single-player"],
  note: "",
  rawgSlug: "game",
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
  indie: "all",
};

describe("tierOf", () => {
  it("maps scores to tiers", () => {
    expect(tierOf(95)).toBe("S");
    expect(tierOf(92)).toBe("A");
    expect(tierOf(89)).toBe("A−");
    expect(tierOf(86)).toBe("B");
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

describe("confidenceOf", () => {
  it("is 0 with no sample and ~1 with a large sample", () => {
    expect(confidenceOf(0)).toBe(0);
    expect(confidenceOf(1_000_000)).toBe(1);
  });
});

describe("rank — critic/player blend", () => {
  it("sorts by composite descending", () => {
    const out = rank([make({ title: "Low", metacritic: 80 }), make({ title: "High", metacritic: 98 })]);
    expect(out[0].title).toBe("High");
    expect(out[0].composite).toBeGreaterThan(out[1].composite);
  });

  it("at players=0, the composite is exactly the Metacritic score", () => {
    const g = make({ metacritic: 90, steamPositive: 60, steamReviews: 100_000 });
    expect(rank([g], 0)[0].composite).toBe(90);
  });

  it("at players=1, a low player score drags a critic favourite down", () => {
    const g = make({ metacritic: 90, steamPositive: 60, steamReviews: 100_000 });
    const r = rank([g], 1)[0];
    expect(r.players).toBe(60);
    expect(r.playerSource).toBe("steam");
    expect(r.composite).toBeLessThan(65); // pulled toward the 60% player score
  });

  it("falls back to the RAWG community rating (calibrated) when there is no Steam data", () => {
    const g = make({ metacritic: 80, rawgRating: 4.5, rawgRatingsCount: 5000 });
    const r = rank([g], 1)[0];
    expect(r.playerSource).toBe("rawg");
    expect(r.players).toBe(93.1); // 50.9 + 9.38·4.5, calibrated onto the Steam-% scale
    expect(r.composite).toBeGreaterThan(80); // pulled up toward ~93
  });

  it("a game with no player signal keeps its critic score at any weight", () => {
    const g = make({ metacritic: 91, steamPositive: null, steamReviews: null, rawgRating: null });
    expect(rank([g], 1)[0].composite).toBe(91);
    expect(rank([g], 0.5)[0].composite).toBe(91);
  });

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

  it("more reviews give player sentiment more pull", () => {
    const games = [
      make({ title: "Few", metacritic: 90, steamPositive: 60, steamReviews: 50 }),
      make({ title: "Many", metacritic: 90, steamPositive: 60, steamReviews: 500_000 }),
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

  it("filters by genre and search", () => {
    expect(applyFilters(games, { ...baseFilters, genre: "Action & Adventure" })).toHaveLength(1);
    expect(applyFilters(games, { ...baseFilters, search: "rpg 2016" })).toHaveLength(1);
  });

  it("indie filter is tri-state: all / only / exclude", () => {
    expect(applyFilters(games, { ...baseFilters, indie: "all" })).toHaveLength(3);
    expect(applyFilters(games, { ...baseFilters, indie: "only" }).map((g) => g.title)).toEqual(["Both 2020"]);
    const noIndie = applyFilters(games, { ...baseFilters, indie: "exclude" });
    expect(noIndie).toHaveLength(2);
    expect(noIndie.some((g) => g.indie)).toBe(false);
  });

  it("exposes the four canonical modes", () => {
    expect(MODES).toEqual(["Single-player", "Co-op", "PvP", "Live-service"]);
  });
});
