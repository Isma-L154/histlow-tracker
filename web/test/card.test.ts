/**
 * That the page a scraper reads actually carries the bigger picture.
 *
 * `art.ts` decides which picture and `preview.ts` writes it, and both are
 * tested on their own. Neither can see the line that joins them - and a
 * mutation replacing that line with `null` passes every one of those tests
 * while every card silently goes back to the small one.
 *
 * So Steam is stubbed, the whole route is run, and the assertion is made on
 * the document as it leaves.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index.ts";

const APP = 367520;
const BASE = "https://howtoachieve.cloudils.com";
const HEADER = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APP}/3c3489495136b26b34f8a9543c7f5645b99d388c/header.jpg?t=1776125684`;
const CAPSULE = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APP}/capsule_616x353.jpg`;

/**
 * Steam, as far as this route needs it.
 *
 * `capsulePresent` is the one thing under test; everything else is scenery,
 * kept to the fields the client reads.
 */
function steam(capsulePresent: boolean) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);

    if (init?.method === "HEAD") {
      expect(url, "the probe asked for something other than the capsule").toBe(CAPSULE);
      return new Response(null, { status: capsulePresent ? 200 : 404 });
    }
    if (url.includes("GetSchemaForGame")) {
      return Response.json({
        game: { availableGameStats: { achievements: [{ name: "a", displayName: "An achievement" }] } },
      });
    }
    if (url.includes("GetGlobalAchievementPercentages")) {
      return Response.json({ achievementpercentages: { achievements: [{ name: "a", percent: 1.5 }] } });
    }
    if (url.includes("appdetails")) {
      return Response.json({ [APP]: { success: true, data: { name: "Hollow Knight", header_image: HEADER } } });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

async function card(): Promise<Record<string, string>> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}/game/${APP}`), env, ctx);
  await waitOnExecutionContext(ctx);

  const html = await response.text();
  const tags: Record<string, string> = {};
  for (const [, property, content] of html.matchAll(
    /<meta property="(og:image(?::\w+)?)" content="([^"]*)" \/>/g,
  )) {
    tags[property!] = content!;
  }
  return tags;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the card a shared game link produces", () => {
  it("carries the capsule, at the size it really is", async () => {
    steam(true);
    const tags = await card();

    expect(tags["og:image"]).toBe(CAPSULE);
    expect(tags["og:image:width"]).toBe("616");
    expect(tags["og:image:height"]).toBe("353");
  });

  it("falls back to the header when the capsule is not there", async () => {
    steam(false);
    const tags = await card();

    expect(tags["og:image"]).toBe(HEADER);
    expect(tags["og:image:width"]).toBe("460");
    expect(tags["og:image:height"]).toBe("215");
  });

  it("sends one image, never two", async () => {
    // The shell ships the site's own card. Two `og:image` tags leave the
    // choice to whichever scraper is reading, and they do not agree.
    steam(true);
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE}/game/${APP}`), env, ctx);
    await waitOnExecutionContext(ctx);

    const html = await response.text();
    expect([...html.matchAll(/<meta property="og:image" content=/g)]).toHaveLength(1);
  });
});
