/**
 * An address that matches nothing answers 404 with a page of its own.
 *
 * The single-page fallback used to answer every such address with the home page
 * and a 200: a mistyped link looked like a working one, and search engines
 * indexed the home page under every address a scraper invented.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { DICTIONARY } from "../public/i18n.js";

const BASE = "https://howtoachieve.cloudils.com";

async function request(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("an unknown address", () => {
  it("answers 404 with the not-found page, not the home page", async () => {
    const response = await request("/no-such-page");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(body).toContain(DICTIONARY.en["notFound.title"]);
    expect(body).not.toContain('id="search"');
  });

  it("is written in the reader's language", async () => {
    const response = await request("/no-such-page", { headers: { "Accept-Language": "es" } });
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toMatch(/<html[^>]*\slang="es"/);
    expect(body).toContain(DICTIONARY.es["notFound.title"]);
  });

  it("answers a HEAD the same way, without the body", async () => {
    const response = await request("/no-such-page", { method: "HEAD" });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("offers a way back to the search", async () => {
    const body = await (await request("/no-such-page")).text();
    const main = /<main[\s\S]*?<\/main>/.exec(body);

    expect(main, "no main element").not.toBeNull();
    expect(main![0]).toMatch(/<a[^>]*href="\/"/);
  });
});

describe("the addresses that exist", () => {
  it.each(["/", "/privacy", "/terms"])("%s still answers 200", async (path) => {
    expect((await request(path)).status).toBe(200);
  });
});
