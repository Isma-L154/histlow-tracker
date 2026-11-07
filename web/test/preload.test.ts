/**
 * That the shell announces every file the first paint and the client need.
 *
 * Without the hints the browser finds them a round trip at a time: the fonts
 * only once the stylesheet is parsed, and each module only once the module
 * importing it has arrived, three levels deep. Both lists are derived from the
 * files as served, so a new import or font that is not preloaded fails here
 * instead of quietly adding a round trip.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { serve } from "./serve.ts";

const BASE = "https://howtoachieve.cloudils.com";

let shell: string;

async function text(path: string): Promise<string> {
  const response = await serve(new Request(`${BASE}${path}`));
  expect(response.status, path).toBe(200);
  return response.text();
}

/** The `href` of every `<link rel="…">` of this kind in the shell. */
function hinted(rel: string): string[] {
  return [...shell.matchAll(/<link\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => new RegExp(`\\brel="${rel}"`).test(tag))
    .map((tag) => /\bhref="([^"]+)"/.exec(tag)?.[1] ?? "");
}

/** Every module reachable from the entry point, as absolute paths. */
async function moduleGraph(entry: string): Promise<string[]> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = await text(path);
    for (const [, specifier] of source.matchAll(/^import\b[^"']*["']([^"']+)["']/gm)) {
      queue.push(new URL(specifier!, `${BASE}${path}`).pathname);
    }
  }
  seen.delete(entry);
  return [...seen].sort();
}

beforeAll(async () => {
  shell = await text("/");
});

describe("the shell's preload hints", () => {
  it("preloads every module the client imports", async () => {
    const graph = await moduleGraph("/app.js");
    expect(graph.length).toBeGreaterThan(0);
    expect(hinted("modulepreload").sort()).toEqual(graph);
  });

  it("preloads every font the stylesheet uses, as a CORS fetch", async () => {
    const css = await text("/styles.css");
    const fonts = [...css.matchAll(/url\("?(\/fonts\/[^")]+\.woff2)"?\)/g)].map((match) => match[1]!).sort();
    expect(fonts.length).toBeGreaterThan(0);
    expect(hinted("preload").sort()).toEqual(fonts);

    // A font preload without `crossorigin` is fetched twice: fonts are always CORS requests.
    for (const tag of shell.match(/<link\b[^>]*rel="preload"[^>]*>/g) ?? []) {
      expect(tag).toMatch(/\bas="font"/);
      expect(tag).toMatch(/\btype="font\/woff2"/);
      expect(tag).toMatch(/\bcrossorigin\b/);
    }
  });
});

describe("font caching", () => {
  it("lets a returning visitor use the fonts without asking again", async () => {
    const response = await serve(new Request(`${BASE}/fonts/press-start-2p.woff2`));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toMatch(/max-age=31536000/);
    expect(response.headers.get("Cache-Control")).toMatch(/immutable/);
  });
});
