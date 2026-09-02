/**
 * The old address, after the rename.
 *
 * `cazalogros.cloudils.com` has been shared, bookmarked and indexed, and it is
 * listed in `sitemap.xml`. It stays routed to this Worker so those links can be
 * answered rather than dropped, and every one of them is sent to the same path
 * on the new host.
 *
 * The alternative - leaving the old host serving the site - was ruled out by a
 * decision already written into `wrangler.jsonc` about the workers.dev address:
 * two live URLs for one site means the old one keeps being linked, and every
 * later decision about the domain gets made twice.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

const OLD = "https://cazalogros.cloudils.com";
const NEW = "https://howtoachieve.cloudils.com";

async function get(url: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(url, { redirect: "manual" }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the old host", () => {
  it.each([
    ["the home page", "/"],
    ["a game page", "/game/367520"],
    ["the privacy page", "/privacy"],
    ["the terms page", "/terms"],
    ["an api route", "/api/health"],
    ["a path that does not exist", "/nothing-here"],
  ])("redirects %s permanently", async (_name, path) => {
    // These call the handler directly, so they prove what it does once it is
    // reached - not that it is reached. Whether a path invokes the Worker at
    // all is decided by `run_worker_first` in wrangler.jsonc, which this pool
    // does not apply. The fall-through case above is exactly where those two
    // differ, and it was verified separately against a running server.
    const response = await get(`${OLD}${path}`);
    // 301 rather than 302: the move is permanent, and a temporary redirect
    // would leave search engines indexing the old address indefinitely.
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe(`${NEW}${path}`);
  });

  it("keeps the query string", async () => {
    // A shared game link can carry ?steamid=, and dropping it would silently
    // change what the reader sees.
    const response = await get(`${OLD}/game/367520?steamid=76561198000000000`);
    expect(response.headers.get("Location")).toBe(`${NEW}/game/367520?steamid=76561198000000000`);
  });

  it("redirects before doing any work", async () => {
    // An id this long is refused by the route pattern. Reaching a 404 would
    // mean the redirect runs after routing, so a reader on an old link would
    // get an error page on an address that no longer exists.
    expect((await get(`${OLD}/api/game/12345678901`)).status).toBe(301);
  });
});

describe("the new host", () => {
  it("serves the site rather than redirecting", async () => {
    expect((await get(`${NEW}/api/health`)).status).toBe(200);
  });

  it("does not redirect to itself", async () => {
    // A redirect keyed on anything but the old host exactly would loop here.
    expect((await get(`${NEW}/`)).status).not.toBe(301);
  });

  it("leaves an unrelated host alone", async () => {
    // Local development and preview URLs are neither host, and must keep
    // working rather than being bounced to production.
    expect((await get("http://127.0.0.1:8787/api/health")).status).toBe(200);
  });
});
