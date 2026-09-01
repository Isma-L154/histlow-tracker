/**
 * That `hidden` actually hides.
 *
 * The client shows and hides nine elements through the `hidden` property. That
 * property works by way of the browser's own `[hidden] { display: none }` rule,
 * which any author `display` declaration outranks - so an element can carry
 * `hidden` and stay on screen. `.filters { display: flex }` did exactly that,
 * leaving the "Me faltan" and "Conseguidos" chips visible for visitors with no
 * SteamID, filtering against unlock data they did not have.
 *
 * The same trap caught `.achievement` earlier and was patched in place. Rather
 * than assert the absence of the second instance, these tests assert the rule
 * that makes a third impossible.
 *
 * The stylesheet is fetched through the Worker rather than imported, because
 * that is the copy visitors get, and because Vite's CSS pipeline intercepts a
 * `?raw` import of a stylesheet and hands back an empty string.
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

/** The body of every rule whose selector is exactly `[hidden]`. */
function globalHiddenRules(): string[] {
  return [...css.matchAll(/(?:^|\n)\s*\[hidden\]\s*\{([^}]*)\}/g)].map((match) => match[1]!);
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
    // `!important` yields only to another `!important`, so a second one on
    // `display` would put the guarantee back in doubt.
    expect([...css.matchAll(/display:\s*[^;]*!important/g)]).toHaveLength(1);
  });
});
