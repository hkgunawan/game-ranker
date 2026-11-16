import { describe, expect, it } from "vitest";
import games from "./games.json";

// Guards the generated dataset itself. The refresh workflow runs this before it
// commits, so a pipeline that "succeeds" while producing hollow data (Steam
// coverage once fell from ~700 games to 0 with every run green) cannot ship.
describe("games.json", () => {
  it("is a healthy-sized list", () => {
    expect(Array.isArray(games)).toBe(true);
    expect(games.length).toBeGreaterThanOrEqual(500);
  });

  it("gives every game a title, year and platform", () => {
    for (const g of games) {
      expect(g.title, JSON.stringify(g).slice(0, 80)).toBeTruthy();
      expect(g.year).toBeGreaterThanOrEqual(2015);
      expect(g.platforms.length).toBeGreaterThan(0);
    }
  });

  it("has Steam player sentiment for most games", () => {
    const withSteam = games.filter((g) => g.steamPositive != null && g.steamReviews);
    expect(withSteam.length / games.length).toBeGreaterThanOrEqual(0.6);
  });

  it("keeps Steam percentages in range", () => {
    for (const g of games) {
      if (g.steamPositive == null) continue;
      expect(g.steamPositive).toBeGreaterThanOrEqual(0);
      expect(g.steamPositive).toBeLessThanOrEqual(100);
    }
  });
});
