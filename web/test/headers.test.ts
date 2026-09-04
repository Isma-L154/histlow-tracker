/**
 * That a response the Worker builds is protected like one the asset runtime
 * serves.
 *
 * `public/_headers` is applied by the asset runtime, so every static file
 * carries the site's Content-Security-Policy and the rest. A response
 * constructed in Worker code never passes through it, and `/game/<id>` - the
 * one document on this site assembled by hand, from a game name written by a
 * developer and relayed by Steam - was shipping with no policy at all. The
 * escaping in `preview.ts` is what stands between a hostile title and the
 * page; a CSP is the layer meant to be there when escaping is wrong, and it
 * was missing exactly where it would be needed.
 *
 * The rule asserted here is a comparison, not a list. A list in the test is a
 * third copy of the same thing, and it would go stale in step with the code it
 * is supposed to catch: adding a header to `_headers` and forgetting the
 * Worker would leave every copy agreeing with every other. So the static side
 * is read at run time and the Worker is required to match it.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { secured } from "../src/headers.ts";

const BASE = "https://howtoachieve.cloudils.com";

/** Headers the asset runtime adds, which say nothing about a specific file. */
async function siteWide(): Promise<Map<string, string>> {
  const asset = await env.ASSETS.fetch(new Request(`${BASE}/index.html`));
  const policy = new Map<string, string>();
  for (const [name, value] of asset.headers) {
    if (!ENTITY.has(name.toLowerCase())) policy.set(name.toLowerCase(), value);
  }
  return policy;
}

/** Headers that describe one response rather than the site, so cannot be copied. */
const ENTITY = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "age",
  "date",
  "vary",
  "accept-ranges",
  "cf-cache-status",
]);

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("security headers", () => {
  it("finds a policy on the static side to compare against", async () => {
    // Without this the comparison below passes by having nothing to compare.
    // That is not hypothetical: `?raw` on a stylesheet returns an empty string
    // in this pool, and a test in this suite asserted against it for a day.
    const policy = await siteWide();
    expect([...policy.keys()]).toContain("content-security-policy");
    expect(policy.size).toBeGreaterThan(3);
  });

  it("gives a Worker-built JSON response every header the static side has", async () => {
    const policy = await siteWide();
    const response = await get("/api/health");

    expect(response.status).toBe(200);
    for (const [name, value] of policy) {
      expect(response.headers.get(name), `/api/health is missing ${name}`).toBe(value);
    }
  });

  it("leaves the headers the response owns alone", async () => {
    // The copy must not overwrite what the route decided. A JSON body served
    // as `text/html` because a policy header brought its neighbour along would
    // be a worse bug than the one being fixed.
    const response = await get("/api/health");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  it("does not overrule a header the route set deliberately", async () => {
    // Asserted here rather than through a route, because no route sets one
    // today - so a mutation removing the check passes every test that goes
    // through the Worker. That is not a reason to leave the check unguarded:
    // the first route to want a narrower policy for one page would find it
    // silently replaced by the site-wide one.
    const own = new Response("{}", { headers: { "referrer-policy": "same-origin" } });
    const out = await secured(own, env, BASE);

    expect(out.headers.get("referrer-policy")).toBe("same-origin");
    expect(out.headers.get("content-security-policy"), "the rest still arrived").not.toBeNull();
  });

  it("returns the very same response when there is nothing to add", async () => {
    // Identity, not equivalence. A rebuilt response is indistinguishable by
    // its headers, so only this can tell whether the majority of requests -
    // every stylesheet, script and image - pay for a copy that changes
    // nothing.
    const policy = await siteWide();
    const complete = new Response("body", { headers: Object.fromEntries(policy) });

    expect(await secured(complete, env, BASE)).toBe(complete);
  });

  it("protects a redirect too", async () => {
    // `Response.redirect` returns a response whose headers cannot be written,
    // so this path fails differently from the others: not by omission but by
    // throwing, and only for readers arriving on an old link.
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://cazalogros.cloudils.com/game/413150", { redirect: "manual" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`${BASE}/game/413150`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("passes an asset response through without rebuilding it", async () => {
    // The asset runtime has already applied the policy on this path, so there
    // is nothing to add - and rewrapping a response that is being streamed,
    // for nothing, is a cost paid on the majority of requests.
    const response = await get("/styles.css");
    expect(response.headers.get("content-security-policy")).not.toBeNull();
    expect(response.headers.get("ETag"), "the asset's own validator survived").not.toBeNull();
  });
});
