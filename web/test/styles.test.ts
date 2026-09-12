/**
 * That `hidden` actually hides.
 *
 * The property works through the browser's own `[hidden] { display: none }`,
 * which any author `display` declaration outranks - so `.filters { display:
 * flex }` left the filter chips on screen for visitors with no SteamID,
 * filtering against unlock data they did not have. Rather than assert the
 * absence of that one case, these assert the rule that makes a third impossible.
 *
 * The stylesheet is fetched through the Worker because that is the copy
 * visitors get, and because Vite hands back an empty string for a `?raw`
 * import of a stylesheet.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.ts";

let css: string;

beforeAll(async () => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("https://example.com/styles.css"), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  css = await response.text();
});

/** The stylesheet without comments, which quote the very declarations these look for. */
function declarations(): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The body of every rule whose selector is exactly `[hidden]`. */
function globalHiddenRules(): string[] {
  return [...declarations().matchAll(/(?:^|[\n;}])\s*\[hidden\]\s*\{([^}]*)\}/g)].map((m) => m[1]!);
}

describe("the hidden attribute outranks the stylesheet", () => {
  it("declares a global [hidden] rule", () => {
    expect(globalHiddenRules()).not.toHaveLength(0);
  });

  it("makes that rule win against any author display declaration", () => {
    // Without `!important` this rule loses to `.filters { display: flex }` on
    // specificity, which is the whole bug.
    const wins = globalHiddenRules().some((body) => /display:\s*none\s*!important/.test(body));
    expect(wins).toBe(true);
  });

  it("has nothing else that could outrank it", () => {
    // Only a competing `!important` on `display` can put the guarantee in doubt;
    // a second `display: none !important` agrees with the guard. The lookahead
    // sits against the colon and swallows the spacing itself, because `\s*`
    // before it can give the space back and match the guard itself.
    const rivals = [...declarations().matchAll(/display:(?!\s*none\s*!important)[^;}]*!important/g)];
    expect(rivals.map((m) => m[0])).toEqual([]);
  });
});
