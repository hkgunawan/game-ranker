import { describe, expect, it } from "vitest";
import { bestGenre } from "../../scripts/lib/genre.mjs";

describe("bestGenre", () => {
  it("files turn-based RPGs under RPG, not Strategy", () => {
    expect(bestGenre(["Adventure", "RPG", "Strategy"])).toBe("RPG"); // Baldur's Gate 3
    expect(bestGenre(["RPG", "Strategy"])).toBe("RPG"); // Divinity: Original Sin 2
  });

  it("keeps pure strategy games in Strategy", () => {
    expect(bestGenre(["Strategy", "Simulation"])).toBe("Strategy & 4X");
    expect(bestGenre(["Strategy", "Casual", "Indie"])).toBe("Strategy & 4X");
  });

  it("does not treat Indie as a genre", () => {
    expect(bestGenre(["Action", "Adventure", "Indie"])).toBe("Action & Adventure"); // Valheim
    expect(bestGenre(["Action", "Indie"])).toBe("Action & Adventure");
    expect(bestGenre(["Indie"])).toBe("Action & Adventure");
  });

  it("still prefers the more specific bucket", () => {
    expect(bestGenre(["Action", "Shooter", "RPG"])).toBe("Shooter & FPS");
    expect(bestGenre(["Action", "Indie", "Platformer"])).toBe("Platformer & Metroidvania");
    expect(bestGenre(["Adventure", "Indie", "Puzzle"])).toBe("Puzzle & Exploration");
  });

  it("returns Other for an empty list", () => {
    expect(bestGenre([])).toBe("Other");
  });
});
