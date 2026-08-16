// Expiry rules for the Steam metadata cache (data/steam-meta.json). Pure — no
// network, no filesystem — so the "does this appid need a call?" decision is
// unit-tested rather than only exercised by a two-hour build.
import type { SteamDetail } from "./steam-catalog";

// Only real details are ever cached. A `null` from appDetails means Steam
// answered `{"<appid>": {"success": false}}`, which it sends BOTH for genuinely
// delisted apps and for soft-throttled requests — indistinguishable here, so
// banking one as "not found" risks poisoning the cache for months. Delisted
// apps above the 2,000-review gate are rare, so re-asking about them weekly is
// the cheap side of that trade.
export interface SteamCacheEntry {
  fetchedAt: string; // ISO timestamp
  detail: SteamDetail;
}
export type SteamMetaCache = Record<string, SteamCacheEntry>;

export const CACHE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // re-check a cached appid after 180 days
// An unreleased game's entry is useless to the board (no year -> it fails the
// catalogue gate) and goes stale the moment it ships. At the 180-day expiry it
// could sit off the board for up to half a year after release; a one-week
// expiry re-checks it promptly. The population is tiny — a game needs 2,000+
// reviews to reach the cache at all — so this costs a handful of calls a run.
export const COMING_SOON_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function entryMaxAgeMs(entry: SteamCacheEntry): number {
  return entry.detail?.comingSoon ? COMING_SOON_MAX_AGE_MS : CACHE_MAX_AGE_MS;
}

// null for "no entry at all" — absent is not a kind of "old", and collapsing
// the two (e.g. by returning Infinity) is what lets a refresh cap silently
// starve the initial cache fill. An entry with an unreadable timestamp IS
// present but untrustworthy, so it gets Infinity: maximally expired.
export function entryAgeMs(entry: SteamCacheEntry | undefined, now: number): number | null {
  if (!entry) return null;
  const fetchedAt = Date.parse(entry.fetchedAt);
  return Number.isNaN(fetchedAt) ? Infinity : now - fetchedAt;
}

export type CacheState = "absent" | "fresh" | "expired";

export function cacheState(entry: SteamCacheEntry | undefined, now: number): CacheState {
  if (!entry) return "absent";
  return entryAgeMs(entry, now)! > entryMaxAgeMs(entry) ? "expired" : "fresh";
}
