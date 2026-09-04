/**
 * That a message meant for a reader reaches them in their own language.
 *
 * The site's content is English and its interface speaks both, so a response
 * the client cannot translate is a response some reader gets in the wrong
 * language. The client's rule is simple: a `reason` key wins, and the prose in
 * `error` is only ever the last fallback.
 *
 *   const key = body?.reason && DICTIONARY.en[body.reason] ? body.reason : ERROR_KEYS[response.status];
 *   throw new Error(key ? say(key) : (body?.error ?? say("error.api", …)));
 *
 * Every route honours that through `problem()` - except the how-to limit,
 * which built its own response and shipped a Spanish sentence to every reader
 * on a site whose content is English. It survived #46 because that sweep read
 * the strings `problem()` was called with, and this one is not among them.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { DICTIONARY } from "../public/i18n.js";
import index from "../src/index.ts?raw";
import http from "../src/http.ts?raw";
import steam from "../src/steam.ts?raw";
import guides from "../src/guides.ts?raw";
import howtoSource from "../src/howto.ts?raw";

const BASE = "https://example.com";
/** A key that fails validation, so the route is exercised without reaching Steam. */
const CHEAP = "/api/howto/367520/%FF%FE";

async function throttled(ip: string): Promise<Response> {
  for (let i = 0; i < 40; i++) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${BASE}${CHEAP}`, { headers: { "CF-Connecting-IP": ip } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    if (response.status === 429) return response;
  }
  throw new Error("the limit never tripped, so this test proves nothing");
}

describe("a throttled how-to request", () => {
  it("carries a key the client can translate", async () => {
    const body = (await (await throttled("203.0.113.40")).json()) as {
      error: string;
      reason?: string;
    };

    expect(body.reason, "without a key the client shows the server's prose").toBeTruthy();
    expect(DICTIONARY.en[body.reason!], `${body.reason} is not in the dictionary`).toBeTruthy();
    expect(DICTIONARY.es[body.reason!], `${body.reason} has no Spanish`).toBeTruthy();
  });

  it("still says how long to wait, and is still not cached", async () => {
    // Both were on the hand-built response, and both are easy to lose while
    // routing it through a helper whose other callers need neither.
    const response = await throttled("203.0.113.41");

    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("prose in the Worker", () => {
  const sources = { index, http, steam, guides, howto: howtoSource };

  it("is not in Spanish", async () => {
    // A blunt check, and blunt is what was missing: #46 swept by hand and left
    // eight strings behind, then this one after that. Characters no English
    // sentence uses, and the two words that were actually shipped.
    for (const [name, source] of Object.entries(sources)) {
      const found = [...source.matchAll(/"[^"\n]*(?:[áéíóúñ¿¡]|\b(?:Espera|Demasiadas|Logro)\b)[^"\n]*"/gi)];
      expect(found.map((m) => m[0]), `${name}.ts still has Spanish prose`).toEqual([]);
    }
  });

  it("is not built into a response by hand", async () => {
    // The rule behind the rule. `problem()` is what attaches a `reason`, and
    // anything spelling out an error body itself is a route that has quietly
    // opted out of being translated - which is how a Spanish sentence lived
    // here through a translation pass whose whole job was to find it.
    const rogue = [...index.matchAll(/JSON\.stringify\(\{\s*error:/g)];
    expect(rogue.map((m) => m[0]), "build it with problem() instead").toEqual([]);
  });
});
