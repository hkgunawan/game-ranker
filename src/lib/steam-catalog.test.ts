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
