/**
 * What happens when the site's policy cannot be read.
 *
 * A separate file because `remembered` in `headers.ts` is module state, and
 * the pool gives each test file its own copy of the module. Alongside the
 * other tests, every one of these would run against a policy some earlier test
 * had already cached, and would pass without reaching the code it names.
 *
 * These matter more than their size suggests. The first version of this module
 * treated "the fetch did not throw" as success, so a 404 from the asset
 * binding produced an empty policy, cached it for the life of the isolate, and
 * left every page unprotected - with no log, because nothing had failed, and
 * with no visible difference from a response that already had everything.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.ts";
import { policyFrom, secured } from "../src/headers.ts";

/** An env whose asset binding does what the real one is assumed never to do. */
function broken(answer: () => Response | Promise<Response>): Env {
  return { ...env, ASSETS: { fetch: async () => answer() } } as unknown as Env;
}

describe("policyFrom", () => {
  it("refuses a response carrying no headers at all", () => {
    expect(policyFrom(new Headers())).toBeNull();
  });

  it("refuses a response carrying only headers about itself", () => {
    // What a 404 from the asset binding looks like: real headers, no policy.
    const headers = new Headers({ "Content-Type": "text/plain", "Cache-Control": "no-store" });
    expect(policyFrom(headers)).toBeNull();
  });

  it("refuses a policy that lost its Content-Security-Policy", () => {
    // The likeliest real fault, and the one a comparison cannot catch: the CSP
    // line is by far the longest in `_headers`, and it is the one that would
    // be dropped on its own rather than taking the file with it.
    const headers = new Headers({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    expect(policyFrom(headers)).toBeNull();
  });

  it("keeps the site-wide headers and drops the response's own", () => {
    const headers = new Headers({
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Type": "text/html",
      ETag: '"abc"',
      "CF-Cache-Status": "HIT",
    });

    const policy = policyFrom(headers)!;
    expect([...policy.keys()].sort()).toEqual([
      "content-security-policy",
      "referrer-policy",
      "x-content-type-options",
    ]);
  });
});

describe("when the policy cannot be read", () => {
  const page = () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });

  it("still answers when the asset binding fails outright", async () => {
    const out = await secured(page(), broken(() => { throw new Error("binding gone"); }), "https://x");
    expect(out.status).toBe(200);
  });

  it("still answers when the asset binding is missing entirely", async () => {
    // What renaming the binding in wrangler.jsonc looks like from in here.
    const out = await secured(page(), {} as unknown as Env, "https://x");
    expect(out.status).toBe(200);
  });

  /** A reference response that does carry a usable policy. */
  const good = () =>
    new Response("ok", {
      headers: { "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" },
    });

  it("does not adopt the policy of an error page", async () => {
    // Cloudflare applies `_headers` to its error responses too, so a failing
    // reference does not arrive bare - it arrives with a policy that is not
    // necessarily the site's. Two separate tests because the status check and
    // the floor below mask each other: a 404 with nothing on it is refused by
    // either one alone, so a single test lets a mutation to one of them pass.
    const errorPage = () =>
      new Response("gone", {
        status: 503,
        headers: { "Content-Security-Policy": "default-src 'self'", "X-Content-Type-Options": "nosniff" },
      });

    const out = await secured(page(), broken(errorPage), "https://x");
    expect(out.headers.get("content-security-policy")).toBeNull();
  });

  it("does not latch a reference that answers without a policy", async () => {
    // The failure the first version of this module shipped with: the fetch
    // succeeded, the loop produced an empty map, and the map was cached for
    // the life of the isolate. Every page went out bare, nothing was logged,
    // and from inside there was no way to tell it apart from a response that
    // already had everything.
    const bare = () => new Response("ok", { headers: { "Content-Type": "text/html" } });
    const out = await secured(page(), broken(bare), "https://x");
    expect(out.headers.get("content-security-policy")).toBeNull();

    // Having failed once, it must not have poisoned itself.
    const after = await secured(page(), broken(good), "https://x");
    expect(after.headers.get("content-security-policy")).toBe("default-src 'none'");
  });

  it("does not throw on a response that cannot carry a body", async () => {
    // `secured` runs on everything the Worker produces, so a throw here would
    // not cost a policy - it would cost the page, on a path that could not
    // fail before this module existed.
    const empty = new Response(null, { status: 304 });
    await expect(secured(empty, broken(() => { throw new Error("no"); }), "https://x")).resolves.toBeDefined();
  });
});

describe("the funnel", () => {
  it("answers rather than letting the runtime do it", async () => {
    // Only `route` was guarded, so a throw on the asset path or in `gamePage`
    // escaped the handler and the runtime replied with a 1101 - no policy, no
    // log, and nothing in the response saying what happened. Asserted here
    // because a request that reaches the funnel at all cannot reach this any
    // other way: the binding has to be the thing that breaks.
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://howtoachieve.cloudils.com/privacy"),
      broken(() => {
        throw new Error("asset binding gone");
      }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
  });
});
