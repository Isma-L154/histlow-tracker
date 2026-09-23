/**
 * Steam, as far as a game page needs it.
 *
 * Building `/game/<id>` costs three Steam calls and a HEAD probe for the
 * capsule. A test that leaves them unstubbed reaches the real API, and the
 * pool gives up before the Worker does: `steam.ts` allows the client 8000ms
 * while vitest allows a test 5000ms, so a slow Steam kills the test at 5s and
 * the client's own abort never runs. That is a failure with no bug behind it,
 * and it lands on whoever pushed next.
 *
 * Anything not listed here throws rather than falling through to the network,
 * so a route that starts calling somewhere new says so instead of going quiet
 * and flaky.
 */
import { expect, vi, type MockInstance } from "vitest";

export const APP_ID = 367520;
export const GAME_NAME = "Hollow Knight";

const HEADER_IMAGE = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${APP_ID}/header.jpg`;

/** Stubs `fetch` for the duration of a test, and hands back the spy to assert on. */
export function stubSteam(): MockInstance {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);

    // The capsule probe. Its absence is what `art.ts` is deciding, and a game
    // page renders either way, so 200 keeps the common path under test.
    if (init?.method === "HEAD") return new Response(null, { status: 200 });

    if (url.includes("GetSchemaForGame")) {
      return Response.json({
        game: { availableGameStats: { achievements: [{ name: "a", displayName: "An achievement" }] } },
      });
    }
    if (url.includes("GetGlobalAchievementPercentages")) {
      return Response.json({ achievementpercentages: { achievements: [{ name: "a", percent: 1.5 }] } });
    }
    if (url.includes("appdetails")) {
      return Response.json({ [APP_ID]: { success: true, data: { name: GAME_NAME, header_image: HEADER_IMAGE } } });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

/**
 * Asserts the stub was actually reached.
 *
 * `caches.default` survives within a test file, so a second request for the
 * same id and language can be answered from that entry without building the
 * page at all - leaving the "unexpected request" net unarmed and the test
 * narrower than it reads.
 */
export function expectBuilt(spy: MockInstance, what: string): void {
  expect(spy.mock.calls.length, `${what} was served from cache, so it built nothing`).toBeGreaterThan(0);
}
