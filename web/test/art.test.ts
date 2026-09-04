/**
 * Which picture a shared link carries, and how big it is said to be.
 *
 * Steam's header art is 460x215. Facebook and WhatsApp render the large card
 * only from 600x315 up, so the game cards were rendering smaller than the
 * generic site card on the platforms with the widest reach.
 *
 * The issue that raised this recorded the 616x353 capsule as missing for two
 * of six games. It is not missing; the URL was wrong, and getting it wrong in
 * the other direction - sending a URL that 404s - would leave those games with
 * no card at all. That is what most of this file is about.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { CAPSULE, HEADER, capsuleUrl, cardArt } from "../src/art.ts";

const PLAIN = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/413150/header.jpg?t=1786554168";
const HASHED =
  "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/3c3489495136b26b34f8a9543c7f5645b99d388c/header.jpg?t=1776125684";
const LEGACY = "https://cdn.cloudflare.steamstatic.com/steam/apps/620/header.jpg";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("capsuleUrl", () => {
  it("derives it from a plain header URL", () => {
    expect(capsuleUrl(PLAIN)).toBe(
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/413150/capsule_616x353.jpg",
    );
  });

  it("drops the content hash rather than reusing it", () => {
    // The whole reason the issue thought these images did not exist. The hash
    // is per asset, not per game, so the capsule is not inside the header's
    // directory - asking for it there returns 404, which is what was measured
    // and recorded as "the game has no capsule".
    expect(capsuleUrl(HASHED)).toBe(
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/capsule_616x353.jpg",
    );
    expect(capsuleUrl(HASHED)).not.toContain("3c3489");
  });

  it("works on the older path shape too", () => {
    // Steam answers on several hosts and the prefix differs between the old
    // ones and the new, which is why this matches on `/apps/<id>/` rather than
    // on anything before it.
    expect(capsuleUrl(LEGACY)).toBe(
      "https://cdn.cloudflare.steamstatic.com/steam/apps/620/capsule_616x353.jpg",
    );
  });

  it("drops the header's cache-buster", () => {
    // `?t=` is the header's revision. A capsule asking for it is at best
    // meaningless and at worst a miss.
    expect(capsuleUrl(PLAIN)).not.toContain("?t=");
  });

  it("refuses anything that is not a Steam header URL", () => {
    for (const hostile of [
      "https://evil.example/apps/1/header.jpg",
      "http://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/header.jpg",
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/413150/capsule_231x87.jpg",
      "not a url",
      "",
    ]) {
      // `evil.example` is refused by the `/apps/<id>/` shape rather than by a
      // host check, and that is worth being explicit about: this only ever
      // rewrites a URL Steam gave us, and only into a sibling of it.
      expect(capsuleUrl(hostile), hostile).toBeNull();
    }
  });
});

describe("cardArt", () => {
  /** Answers a HEAD however the test wants, and records that one was made. */
  function head(reply: () => Response | Promise<Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.method, "the probe must not download the image").toBe("HEAD");
      return reply();
    });
  }

  it("prefers the capsule when the game has one", async () => {
    head(() => new Response(null, { status: 200 }));
    const art = await cardArt(PLAIN);

    expect(art).toEqual({
      url: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/413150/capsule_616x353.jpg",
      ...CAPSULE,
    });
    // Above the 600x315 that decides between a large card and a thumbnail.
    expect(art!.width).toBeGreaterThanOrEqual(600);
    expect(art!.height).toBeGreaterThanOrEqual(315);
  });

  it("falls back to the header when the capsule is not there", async () => {
    // The failure that matters. Sending a 404 as `og:image` would leave the
    // game with no card at all, which is worse than the small one it has.
    head(() => new Response(null, { status: 404 }));
    expect(await cardArt(PLAIN)).toEqual({ url: PLAIN, ...HEADER });
  });

  it("falls back when the probe cannot be made at all", async () => {
    head(() => {
      throw new Error("network");
    });
    expect(await cardArt(PLAIN)).toEqual({ url: PLAIN, ...HEADER });
  });

  it("does not probe a URL it could not derive", async () => {
    const fetched = head(() => new Response(null, { status: 200 }));
    const odd = "https://shared.akamai.steamstatic.com/something/else.jpg";

    expect(await cardArt(odd)).toEqual({ url: odd, ...HEADER });
    expect(fetched).not.toHaveBeenCalled();
  });

  it("has nothing to say about a game with no artwork", async () => {
    const fetched = head(() => new Response(null, { status: 200 }));

    expect(await cardArt(null)).toBeNull();
    expect(await cardArt(undefined)).toBeNull();
    expect(await cardArt("")).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
  });

  it("never reports a size that does not match the picture", async () => {
    // The declared dimensions are what a scraper reserves space with, and the
    // two sizes are different shapes - 2.14:1 against 1.75:1. A card that
    // says one and sends the other is letterboxed or cropped.
    for (const [status, expected] of [
      [200, CAPSULE],
      [404, HEADER],
    ] as const) {
      head(() => new Response(null, { status }));
      const art = (await cardArt(PLAIN))!;
      expect(art.url.includes("capsule"), `status ${status}`).toBe(expected === CAPSULE);
      expect({ width: art.width, height: art.height }).toEqual({ ...expected });
    }
  });
});
