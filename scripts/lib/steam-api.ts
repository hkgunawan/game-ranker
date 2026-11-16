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

// A 429 means the upstream's rate window is already blown for the next
// several seconds to minutes — the normal 1s/2s/3s backoff burns all four
// attempts inside the same throttle period and never actually waits it out.
// 5xx and network errors are a different failure mode (a transient blip, not
// a quota) and keep the short backoff.
const RATE_LIMIT_BACKOFF_MS = [20_000, 40_000, 60_000];

export async function getJsonWithRetry(url: string, deps: Deps = {}): Promise<unknown> {
  const { fetcher = fetch, sleep = defaultSleep, attempts = 4, baseDelayMs = 1_000 } = deps;
  let last = "no response";
  for (let i = 0; i < attempts; i++) {
    let rateLimited = false;
    try {
      // `redirect: "manual"`: Steam retires endpoints by 302-ing them to the
      // store home page. Followed, that is a 200 full of HTML — four slow
      // retries of a parse error per app. Unfollowed, it is a 3xx, which falls
      // into the non-retryable branch below and fails fast with the URL.
      const res = await fetcher(url, { headers: UA, redirect: "manual" });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
      if (res.status === 429) {
        rateLimited = true;
      } else if (res.status < 500) {
        throw Object.assign(new Error(`${url} failed: ${last}`), { nonRetryable: true });
      }
    } catch (err) {
      if ((err as { nonRetryable?: boolean }).nonRetryable) throw err;
      // DNS / connection reset / TLS / a malformed body (Steam occasionally
      // serves an HTML error page with a 200) — all retryable, and the usual
      // shape of an upstream outage. Uncaught, any of these escapes as an
      // opaque crash with no URL context.
      const e = err as Error & { cause?: { code?: string } };
      last = `network error (${e.cause?.code ?? e.message})`;
    }
    if (i < attempts - 1) {
      const delay = rateLimited
        ? RATE_LIMIT_BACKOFF_MS[Math.min(i, RATE_LIMIT_BACKOFF_MS.length - 1)]
        : baseDelayMs * (i + 1);
      await sleep(delay);
    }
  }
  throw new Error(`${url} unreachable after ${attempts} attempts (last: ${last})`);
}

export async function steamSpyPage(page: number, deps: Deps = {}): Promise<SteamSpyRow[]> {
  const body = (await getJsonWithRetry(
    `https://steamspy.com/api.php?request=all&page=${page}`,
    // SteamSpy's usual failure is its own database refusing connections
    // ("Connection failed: Too many connections", served as a 200). That lasts
    // minutes, not seconds, so the default 1s/2s/3s backoff gives up while the
    // outage is still in progress. Wait 60s/120s/180s/240s instead — the `all`
    // endpoint is capped at one request a minute anyway.
    { attempts: 5, baseDelayMs: 60_000, ...deps }
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
  // Steam's official Web API (keyless). The store's per-app endpoint,
  // /appreviews/<id>?json=1, was retired in Oct 2026 and now redirects to the
  // store home page. `summary_filtered` is the all-languages summary the store
  // page shows. It reports a whole-number percentage rather than a raw positive
  // count, so totalPositive is reconstructed from it — accurate to ±0.5 points,
  // where the old endpoint gave one decimal place.
  const input = {
    ids: [{ appid }],
    context: { language: "english", country_code: "US" },
    data_request: { include_reviews: true },
  };
  const body = (await getJsonWithRetry(
    `https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json=${encodeURIComponent(JSON.stringify(input))}`,
    deps
  )) as {
    response?: {
      store_items?: {
        appid?: number;
        success?: number;
        reviews?: { summary_filtered?: { review_count?: number; percent_positive?: number } };
      }[];
    };
  };
  const item = body.response?.store_items?.find((i) => Number(i.appid) === appid);
  const s = item?.reviews?.summary_filtered;
  if (item?.success !== 1 || !s) return null;
  const totalReviews = s.review_count ?? 0;
  return { totalPositive: Math.round((totalReviews * (s.percent_positive ?? 0)) / 100), totalReviews };
}
