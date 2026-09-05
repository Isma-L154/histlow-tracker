/**
 * That HEAD and GET agree about what lives at a URL.
 *
 * `/game/<id>` was routed to `gamePage` only for GET, so a HEAD fell through
 * to the asset runtime and reported on the SPA shell instead: same URL,
 * different title, different description, different cover, and - before #58 -
 * a different set of security headers. `/api/*` answered HEAD with a 405.
 *
 * HTTP asks that HEAD return the headers GET would return. Beyond the letter
 * of it, this is actively misleading during diagnosis: `curl -I` is the reflex
 * for reading headers, and while fixing #58 it reported the game page as
 * already carrying the site's policy when a GET showed it carrying none. The
 * fix was very nearly aimed at the wrong thing.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index.ts";

const BASE = "https://howtoachieve.cloudils.com";

async function ask(method: string, path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}${path}`, { method }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Headers that may legitimately differ between two responses to one URL. */
const VOLATILE = new Set(["date", "age", "cf-cache-status"]);

function comparable(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (!VOLATILE.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HEAD", () => {
  it("is not a 405 on a route that answers GET", async () => {
    // A read-only endpoint refusing HEAD is a plain protocol error, and the
    // reflex for reading a header is exactly the thing it refused.
    expect((await ask("HEAD", "/api/health")).status).toBe(200);
  });

  it("returns the headers GET returns, on the API", async () => {
    const get = await ask("GET", "/api/health");
    const head = await ask("HEAD", "/api/health");

    expect(head.status).toBe(get.status);
    expect(comparable(head)).toEqual(comparable(get));
  });

  it("carries no body", async () => {
    // Stripped here rather than left to the runtime. Cloudflare does strip it,
    // the test pool does not, and a difference between the two is how a thing
    // passes locally and is wrong in production.
    const head = await ask("HEAD", "/api/health");
    expect(await head.text()).toBe("");
  });

  it("reports on the game, not on the shell", async () => {
    // The fault this exists for. A HEAD fell through to the asset runtime, so
    // it described the generic page while GET described Hollow Knight.
    const steam = () =>
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
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
          return Response.json({
            367520: { success: true, data: { name: "Hollow Knight", header_image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/header.jpg` } },
          });
        }
        throw new Error(`unexpected request: ${url}`);
      });

    steam();
    const get = await ask("GET", "/game/367520");
    const body = await get.text();
    vi.restoreAllMocks();

    steam();
    const head = await ask("HEAD", "/game/367520");

    expect(body, "the GET itself stopped describing the game").toContain("Hollow Knight");
    expect(head.status).toBe(get.status);
    expect(comparable(head)).toEqual(comparable(get));
  });

  it("still refuses a method that changes things", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect((await ask(method, "/api/health")).status, method).toBe(405);
    }
  });
});
