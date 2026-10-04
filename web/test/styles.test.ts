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

/** What the stylesheet defines, and what it reads without a fallback. */
function customProperties(): { used: Set<string>; defined: Set<string> } {
  const css = declarations();
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  // Only a `var()` with no fallback. One with a fallback is deliberate:
  // `--topbar-height` is published by the client and is absent until it is.
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]!));
  return { used, defined };
}

describe("every custom property it reads is defined", () => {
  it("reads none that resolve to nothing", () => {
    // An undefined `var()` with no fallback is invalid at computed-value time,
    // so the declaration silently takes its inherited or initial value instead.
    // `--ok` did exactly that: `border-left-color` fell back to `currentColor`,
    // and every unlocked achievement was marked in the text colour rather than
    // the green it was meant to be. Nothing failed, and nothing said so.
    const { used, defined } = customProperties();
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it("found properties at all", () => {
    // Guards the guard: a regex matching nothing would assert nothing.
    const { used, defined } = customProperties();
    expect(used.size).toBeGreaterThan(5);
    expect(defined.size).toBeGreaterThan(5);
  });
});

/** Every rule as selector and body. A rule nested in an at-rule comes out on its own. */
function rules(): { selector: string; body: string }[] {
  return [...declarations().matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim(),
    body: m[2]!,
  }));
}

/** The last layer of a rule's `background`, which is the one everything else sits on. */
function baseLayer(body: string): string | undefined {
  const value = /background:([^;]+)/.exec(body)?.[1];
  if (value === undefined) return undefined;
  // Layers part at top-level commas only; `color-mix()` has commas of its own.
  let depth = 0;
  let start = 0;
  for (const [i, char] of [...value].entries()) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) start = i + 1;
  }
  return value.slice(start).trim();
}

describe("the sticky bars show no edge against the page", () => {
  // The page sat on a glow fixed to the viewport, and both sticky bars painted
  // an 82% tint of the page colour over it, across the content column only. A
  // tint over a background that varies shows its outline: at rest the top bar
  // read as a darker box against the glow beside it, and scrolled, the cards
  // beneath bled through and the bars turned lighter than the gutters. Painting
  // the glow into the bars with `background-attachment: fixed` would not do:
  // iOS ignores it. So these assert the arrangement that leaves nothing to differ.

  it("keeps the page itself flat", () => {
    const body = rules().find((r) => r.selector === "body");
    expect(body && /background:([^;]+)/.exec(body.body)?.[1]!.trim()).toBe("var(--bg)");
  });

  it("paints every sticky bar on the page colour", () => {
    const sticky = rules().filter((r) => /position:\s*sticky/.test(r.body));
    // Guards the guard: a selector regex that drifted would find nothing to check.
    expect(sticky.map((r) => r.selector)).toEqual(expect.arrayContaining([".topbar", ".toolbar"]));
    expect(sticky.filter((r) => baseLayer(r.body) !== "var(--bg)").map((r) => r.selector)).toEqual([]);
  });
});
