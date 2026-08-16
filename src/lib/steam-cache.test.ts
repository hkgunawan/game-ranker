import { describe, expect, it } from "vitest";
import {
  cacheState,
  entryAgeMs,
  entryMaxAgeMs,
  CACHE_MAX_AGE_MS,
  COMING_SOON_MAX_AGE_MS,
  type SteamCacheEntry,
} from "./steam-cache";
import type { SteamDetail } from "./steam-catalog";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-16T00:00:00.000Z");

const detail = (over: Partial<SteamDetail> = {}): SteamDetail => ({
  type: "game", name: "Game", releaseDate: "Feb 24, 2022", comingSoon: false,
  genres: ["Action"], categories: ["Single-player"], developers: ["Studio"],
  shortDescription: "A game.", metacritic: 94, ...over,
});

const entry = (ageDays: number, over: Partial<SteamDetail> = {}): SteamCacheEntry => ({
  fetchedAt: new Date(NOW - ageDays * DAY).toISOString(),
  detail: detail(over),
});

describe("entryAgeMs", () => {
  it("returns null for an absent entry, not a very large age", () => {
    expect(entryAgeMs(undefined, NOW)).toBeNull();
  });

  it("measures age from fetchedAt", () => {
    expect(entryAgeMs(entry(3), NOW)).toBe(3 * DAY);
  });

  it("treats an unreadable timestamp as maximally expired, not absent", () => {
    const bad: SteamCacheEntry = { fetchedAt: "not a date", detail: detail() };
    expect(entryAgeMs(bad, NOW)).toBe(Infinity);
  });
});

describe("entryMaxAgeMs", () => {
  it("gives a released game the long expiry", () => {
    expect(entryMaxAgeMs(entry(0))).toBe(CACHE_MAX_AGE_MS);
  });

  it("gives a coming-soon game a much shorter expiry", () => {
    expect(entryMaxAgeMs(entry(0, { comingSoon: true }))).toBe(COMING_SOON_MAX_AGE_MS);
    expect(COMING_SOON_MAX_AGE_MS).toBeLessThan(CACHE_MAX_AGE_MS);
  });

  it("re-checks a coming-soon game within about a week", () => {
    expect(COMING_SOON_MAX_AGE_MS).toBeLessThanOrEqual(7 * DAY);
  });
});

describe("cacheState", () => {
  it("reports absent when there is no entry", () => {
    expect(cacheState(undefined, NOW)).toBe("absent");
  });

  it("keeps a released game fresh right up to the 180-day mark", () => {
    expect(cacheState(entry(179), NOW)).toBe("fresh");
    expect(cacheState(entry(181), NOW)).toBe("expired");
  });

  it("expires a coming-soon game after a week, while a released one stays fresh", () => {
    expect(cacheState(entry(30, { comingSoon: true }), NOW)).toBe("expired");
    expect(cacheState(entry(30), NOW)).toBe("fresh");
  });

  it("keeps a coming-soon game fresh inside its short window", () => {
    expect(cacheState(entry(3, { comingSoon: true }), NOW)).toBe("fresh");
  });

  it("expires an entry with an unreadable timestamp", () => {
    expect(cacheState({ fetchedAt: "", detail: detail() }, NOW)).toBe("expired");
  });
});
