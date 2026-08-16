import { describe, expect, it, vi } from "vitest";
import {
  getJsonWithRetry,
  steamSpyPage,
  appDetails,
  appReviews,
} from "../../scripts/lib/steam-api";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number) => new Response("", { status: code });
const noSleep = () => Promise.resolve();

describe("getJsonWithRetry", () => {
  it("returns the parsed body on the first success", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ hello: "world" }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).resolves.toEqual({ hello: "world" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and succeeds", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok({ ok: true }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx and succeeds", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok({ ok: true }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).resolves.toEqual({ ok: true });
  });

  // A 429 means the rate window is blown for seconds-to-minutes, not the
  // usual transient blip — it must wait far longer than a 5xx before retrying,
  // or all four attempts burn inside the same throttle period. Sleep is
  // injected and mocked instantly; only the requested delay is asserted.
  it("waits longer after a 429 than after a 503", async () => {
    const rateLimitSleep = vi.fn().mockResolvedValue(undefined);
    const fetcher429 = vi.fn().mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok({ ok: true }));
    await getJsonWithRetry("https://x", { fetcher: fetcher429, sleep: rateLimitSleep });

    const serverErrorSleep = vi.fn().mockResolvedValue(undefined);
    const fetcher503 = vi.fn().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok({ ok: true }));
    await getJsonWithRetry("https://x", { fetcher: fetcher503, sleep: serverErrorSleep });

    expect(rateLimitSleep).toHaveBeenCalledTimes(1);
    expect(serverErrorSleep).toHaveBeenCalledTimes(1);
    const rateLimitDelay = rateLimitSleep.mock.calls[0][0] as number;
    const serverErrorDelay = serverErrorSleep.mock.calls[0][0] as number;
    expect(rateLimitDelay).toBeGreaterThan(serverErrorDelay);
  });

  // A DNS failure or connection reset throws rather than returning a response.
  // Uncaught, it escapes as an opaque crash — the exact shape of the RAWG outage.
  it("retries a network-level throw", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(ok({ ok: true }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).resolves.toEqual({ ok: true });
  });

  it("does not retry a 404, which will never succeed", async () => {
    const fetcher = vi.fn().mockResolvedValue(status(404));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep })).rejects.toThrow(/404/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget and names the last failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(status(503));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep, attempts: 3 }))
      .rejects.toThrow(/after 3 attempts[\s\S]*503/);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  // Steam occasionally serves an HTML error page with a 200 status. A bare
  // JSON.parse throw here would escape uncaught with no URL context and never
  // get retried — treat it like any other transport failure.
  it("retries a 200 response with an unparsable body, and the final error names the url", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response("<html>not json</html>", { status: 200 }));
    await expect(getJsonWithRetry("https://x", { fetcher, sleep: noSleep, attempts: 2 }))
      .rejects.toThrow(/https:\/\/x[\s\S]*after 2 attempts/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("steamSpyPage", () => {
  it("flattens the appid-keyed object into rows", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      "10": { appid: 10, name: "Counter-Strike", developer: "Valve", positive: 243818, negative: 6427 },
    }));
    const rows = await steamSpyPage(0, { fetcher, sleep: noSleep });
    expect(rows).toEqual([{ appid: 10, name: "Counter-Strike", developer: "Valve", positive: 243818, negative: 6427 }]);
  });

  it("requests the page it was asked for", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({}));
    await steamSpyPage(3, { fetcher, sleep: noSleep });
    expect(String(fetcher.mock.calls[0][0])).toContain("request=all&page=3");
  });
});

describe("appDetails", () => {
  it("flattens Steam's nested success envelope", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      "1245620": {
        success: true,
        data: {
          type: "game", name: "ELDEN RING",
          release_date: { coming_soon: false, date: "Feb 24, 2022" },
          genres: [{ description: "Action" }, { description: "RPG" }],
          categories: [{ description: "Single-player" }],
          developers: ["FromSoftware, Inc."],
          short_description: "A vast world.",
          metacritic: { score: 94 },
        },
      },
    }));
    await expect(appDetails(1245620, { fetcher, sleep: noSleep })).resolves.toEqual({
      type: "game", name: "ELDEN RING", releaseDate: "Feb 24, 2022", comingSoon: false,
      genres: ["Action", "RPG"], categories: ["Single-player"],
      developers: ["FromSoftware, Inc."], shortDescription: "A vast world.", metacritic: 94,
    });
  });

  it("returns null metacritic when Steam has no score", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      "1": { success: true, data: { type: "game", name: "X", release_date: { coming_soon: false, date: "Jan 1, 2020" } } },
    }));
    const d = await appDetails(1, { fetcher, sleep: noSleep });
    expect(d?.metacritic).toBeNull();
    expect(d?.genres).toEqual([]);
  });

  // Steam returns {"999": {"success": false}} for delisted or region-locked apps.
  it("returns null for an app Steam refuses to describe", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ "999": { success: false } }));
    await expect(appDetails(999, { fetcher, sleep: noSleep })).resolves.toBeNull();
  });

  it("sends cc=us and l=english so the date format is predictable", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ "1": { success: false } }));
    await appDetails(1, { fetcher, sleep: noSleep });
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain("cc=us");
    expect(url).toContain("l=english");
  });
});

describe("appReviews", () => {
  it("reads the review summary", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      success: 1, query_summary: { total_positive: 9_500, total_reviews: 10_000 },
    }));
    await expect(appReviews(1, { fetcher, sleep: noSleep }))
      .resolves.toEqual({ totalPositive: 9_500, totalReviews: 10_000 });
  });

  it("returns null when Steam reports no summary", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({ success: 0 }));
    await expect(appReviews(1, { fetcher, sleep: noSleep })).resolves.toBeNull();
  });
});
