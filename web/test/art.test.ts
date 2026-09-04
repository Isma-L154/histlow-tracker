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

  it("refuses a host that is not Steam's", () => {
    // `header_image` relays what a developer put in the store listing.
    // Publishing it was already the behaviour; deriving a URL and *asking* for
    // it from the edge is new, and a URL that reads as Steam is not the same
    // as one that resolves to it.
    //
    // The first of these was the only hostile case here to begin with, and it
    // was refused by the `/apps/<id>/` path shape rather than by anything
    // about the host - so the test was named for a property the code did not
    // have. The second defeats that shape by adding a segment. The fourth is
    // the sharp one: it reads as Steam and resolves to the attacker.
    for (const hostile of [
      "https://evil.example/apps/1/header.jpg",
      "https://evil.example/x/apps/1/header.jpg",
      "https://shared.akamai.steamstatic.com.evil.tld/x/apps/1/header.jpg",
      "https://steamstatic.com@evil.example/x/apps/1/header.jpg",
      "https://127.0.0.1:8080/x/apps/1/header.jpg",
    ]) {
      expect(capsuleUrl(hostile), hostile).toBeNull();
    }
  });

  it("refuses a fragment, which the probe would not see", () => {
    // `fetch` strips the fragment, so a pattern whose `.*` crossed one would
    // verify the *header* and then advertise it at the capsule's dimensions -
    // the probe proving the wrong resource, which is the one failure it
    // exists to prevent.
    expect(capsuleUrl(`${PLAIN.split("?")[0]}#/apps/1/header.jpg`)).toBeNull();
  });

  it("refuses anything that is not a header URL at all", () => {
    for (const wrong of [
      "http://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1/header.jpg",
      "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/413150/capsule_231x87.jpg",
      "not a url",
      "",
    ]) {
      expect(capsuleUrl(wrong), wrong).toBeNull();
    }
  });
});

describe("cardArt", () => {
  /**
   * Answers a probe however the test wants, and records what was asked for.
   *
   * Recorded rather than asserted inside the mock. A failing `expect` in there
   * rejects the fetch, `cardArt` catches it and returns the header, and a test
   * whose expected answer *is* the header passes anyway - so the assertion
   * could never fail on the cases that needed it most.
   */
  function head(reply: (signal: AbortSignal | null | undefined) => Response | Promise<Response>) {
    const asked: {
      url: string;
      method: string | undefined;
      redirect: string | undefined;
      signal: AbortSignal | null | undefined;
    }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      asked.push({ url: String(input), method: init?.method, redirect: init?.redirect, signal: init?.signal });
      return reply(init?.signal);
    });
    return asked;
  }

  /** What the recorded calls looked like, without the signal. */
  function calls(asked: ReturnType<typeof head>) {
    return asked.map(({ url, method }) => ({ url, method }));
  }

  it("prefers the capsule when the game has one", async () => {
    const asked = head(() => new Response(null, { status: 200 }));
    const art = await cardArt(PLAIN);

    // Out here, where a failure cannot be swallowed by `cardArt`'s own catch.
    expect(calls(asked)).toEqual([{ url: art!.url, method: "HEAD" }]);

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
    const asked = head(() => new Response(null, { status: 404 }));
    expect(await cardArt(PLAIN)).toEqual({ url: PLAIN, ...HEADER });
    expect(calls(asked)).toEqual([{ url: capsuleUrl(PLAIN), method: "HEAD" }]);
  });

  it("does not follow a redirect to somewhere it never checked", async () => {
    // What gets published has to be what was verified. Followed, a redirect
    // would make `response.ok` true for a resource at another address - and
    // the card would then advertise the capsule's dimensions for whatever was
    // actually there.
    const asked = head(() => new Response(null, { status: 301, headers: { Location: "/elsewhere.jpg" } }));

    expect(await cardArt(PLAIN)).toEqual({ url: PLAIN, ...HEADER });
    expect(asked[0]?.redirect, "the probe was allowed to follow a redirect").toBe("manual");
  });

  it("gives up rather than holding the page open", async () => {
    // The probe is awaited before the page exists, beside the shell fetch, so
    // a CDN that accepts the connection and then stalls would hold every
    // uncached game page until the runtime killed it. Every other outbound
    // call in this Worker carries a deadline; this one did not.
    //
    // The stub honours the signal rather than ignoring it, which is what the
    // real `fetch` does and what a stub that simply never resolves cannot
    // show: without that, this test hangs for its own timeout and reports the
    // deadline missing whether or not it is there.
    const asked = head(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    expect(await cardArt(PLAIN)).toEqual({ url: PLAIN, ...HEADER });
    expect(asked[0]?.signal, "the probe went out with no deadline").toBeInstanceOf(AbortSignal);
    expect(asked[0]?.signal?.aborted, "the deadline never fired").toBe(true);
  });

  it("falls back when the probe cannot be made at all", async () => {
    head(() => {
      throw new Error("network");
    });
    expect(await cardArt(PLAIN)).toEqual({ url: PLAIN, ...HEADER });
  });

  it("does not probe a URL it could not derive", async () => {
    const asked = head(() => new Response(null, { status: 200 }));
    const odd = "https://shared.akamai.steamstatic.com/something/else.jpg";

    expect(await cardArt(odd)).toEqual({ url: odd, ...HEADER });
    expect(calls(asked)).toEqual([]);
  });

  it("has nothing to say about a game with no artwork", async () => {
    const asked = head(() => new Response(null, { status: 200 }));

    expect(await cardArt(null)).toBeNull();
    expect(await cardArt(undefined)).toBeNull();
    expect(await cardArt("")).toBeNull();
    expect(calls(asked)).toEqual([]);
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
