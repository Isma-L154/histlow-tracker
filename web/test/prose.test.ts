/**
 * That a message meant for a reader reaches them in their own language.
 *
 * The site's content is English and its interface speaks both, so a response
 * the client cannot translate is one some reader gets in the wrong language.
 * The client's rule is simple: a `reason` key wins, and the prose in `error`
 * is only ever the last fallback.
 *
 *   const key = body?.reason && DICTIONARY.en[body.reason] ? body.reason : ERROR_KEYS[response.status];
 *   throw new Error(key ? say(key) : (body?.error ?? say("error.api", …)));
 *
 * The first version of this file was written after a Spanish sentence shipped
 * to every reader, and it had two static guards that recognised *that string*
 * rather than the fault. Both were defeated in review, in one line each: the
 * same sentence as a template literal, and the same body through `json()`
 * instead. One of them also failed correct English code, because a comment
 * mentioning "Pokémon" looked like Spanish to it.
 *
 * What is left is arranged by how much weight it can carry. `known()` makes
 * the duplication impossible rather than policing it, so most of this is now
 * structure rather than pattern-matching, and the two heuristics that remain
 * say plainly that they are heuristics.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { DICTIONARY, LANGUAGES } from "../public/i18n.js";

/**
 * Every module in the Worker, enumerated rather than listed.
 *
 * The first version named five of eleven by hand. That is the shape `http.ts`
 * argues against a few lines from where it is explained, for `LOGGABLE`: an
 * allowlist fails open, and the day somebody adds a module its prose is
 * uncovered and nothing says so.
 */
const SOURCES = import.meta.glob("../src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

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

/** Source with comments removed, so a guard can look at code alone. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The contents of every string literal, whichever quote was used. */
function literals(source: string): string[] {
  return [...code(source).matchAll(/"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
    .filter((text) => text.trim() !== "");
}

describe("the modules this file checks", () => {
  it("are found rather than listed", () => {
    // Guards the guard. Everything below is only as good as this enumeration,
    // and a glob that silently matched nothing would make all of it vacuous.
    expect(Object.keys(SOURCES).length).toBeGreaterThanOrEqual(11);
    expect(Object.keys(SOURCES)).toContain("../src/index.ts");
    for (const [name, source] of Object.entries(SOURCES)) {
      expect(source.length, `${name} came back empty`).toBeGreaterThan(100);
    }
  });
});

describe("a throttled how-to request", () => {
  it("carries a key the client can translate", async () => {
    // The load-bearing one. Every static check below can be walked around;
    // this asks the route what it actually answers. It is what caught the two
    // mutations the static guards missed.
    const body = (await (await throttled("203.0.113.40")).json()) as {
      error: string;
      reason?: string;
    };

    expect(body.reason, "without a key the client shows the server's prose").toBeTruthy();
    for (const language of LANGUAGES) {
      expect(DICTIONARY[language][body.reason!], `${body.reason} has no ${language}`).toBeTruthy();
    }
    // And the prose is the dictionary's, not a second copy of it.
    expect(body.error).toBe(DICTIONARY.en[body.reason!]);
  });

  it("still says how long to wait, and is still not cached", async () => {
    // Both were on the hand-built response, and both are exactly what gets
    // dropped while routing one through a helper whose other callers need
    // neither.
    const response = await throttled("203.0.113.41");

    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("translatable errors", () => {
  it("name a key that exists in every language", () => {
    // `known()` looks the prose up, so a key with no entry would ship the key
    // itself as the sentence. Caught here rather than by a reader seeing
    // `profile.tooMany` where a sentence should be.
    const keys = [...SOURCES["../src/index.ts"]!.matchAll(/\bknown\(\s*\d+\s*,\s*"([^"]+)"/g)].map((m) => m[1]!);

    expect(keys.length, "no known() calls found - has it been renamed?").toBeGreaterThan(2);
    for (const key of keys) {
      for (const language of LANGUAGES) {
        expect(DICTIONARY[language][key], `${key} is missing from ${language}`).toBeTruthy();
      }
    }
  });

  it("do not write the prose a second time", () => {
    // Structure, not pattern-matching: `known` has no message parameter, so a
    // call site cannot supply one. This asserts the signature stays that way,
    // because restoring it is what would quietly reopen the drift.
    //
    // Three places used to write the same sentence twice, and all three had
    // already diverged - the two rate limits and the unknown-profile error.
    // The client displayed the dictionary's copy and any other caller read
    // the other, so the two could disagree about what happened.
    const declaration = /export function known\(([^)]*)\)/.exec(SOURCES["../src/http.ts"]!);
    expect(declaration, "known() has been renamed or removed").not.toBeNull();

    // The whole parameter list, not a prefix of it. Asserting the shape up to
    // `headers?` was the first attempt and a parameter added *after* it would
    // have walked straight past - which is the same mistake, in the test that
    // exists to stop it.
    const parameters = declaration![1]!;
    expect(parameters, "known() must not accept prose").not.toMatch(/\bmessage\b|\berror\b|\btext\b/);
    expect(parameters).toMatch(/reason: string/);
  });

  it("are the only place the wire format is named", () => {
    // `problem` can no longer attach a reason, so prose and key cannot come
    // apart there. What is left is a route spelling out a body itself - which
    // is how the Spanish sentence lived through a translation pass whose whole
    // job was to find it.
    //
    // The rule is that only `http.ts` knows what an error body looks like.
    // Deliberately wider than the first version, which matched exactly
    // `JSON.stringify({ error:` and so missed `json({ error: … })` - the
    // helper already imported into the same file, two lines from the fault.
    // Every shape names `error`, deliberately. `new Response(JSON.stringify(…`
    // on its own was tried and is wrong: two of those build cache entries -
    // the IGDB token and the guide corpus - which no reader ever sees, so the
    // check failed on code that is not the thing it describes.
    const shapes = [
      /\bjson\(\s*\{[^}]*\berror\b/,
      /JSON\.stringify\(\s*\{[^}]*\berror\b/,
      /["']error["']\s*:/,
    ];

    for (const [name, source] of Object.entries(SOURCES)) {
      if (name.endsWith("/http.ts")) continue;
      for (const shape of shapes) {
        expect(shape.test(code(source)), `${name} builds an error body itself: ${shape}`).toBe(false);
      }
    }
  });
});

describe("prose in the Worker", () => {
  /**
   * Words that do not appear in English.
   *
   * A heuristic, and the weakest thing in this file - it cannot recognise
   * Spanish it has not been shown, and it is here only because the fault it
   * describes actually happened. The structure above is what stops it
   * recurring; this catches a careless paste.
   *
   * Words rather than accents. The first version matched `á é í ó ú ñ ¿ ¡`
   * anywhere in a double-quoted span, which failed on a comment mentioning
   * "Pokémon" - and accented game titles relayed from Steam are precisely what
   * this Worker handles. Inverted punctuation stays, because no English
   * sentence contains it.
   */
  const SPANISH =
    /[¿¡]|\b(?:espera|inténtalo|intenta|vuelve|demasiad\w+|consultas|puedes|debes|tienes|todavía|perfil|logros?|juegos?|búsquedas|enlace|navegador|pulsa|pégala|revisa|configurar|dígitos)\b/i;

  it("is not in Spanish, as far as this can tell", () => {
    for (const [name, source] of Object.entries(SOURCES)) {
      const found = literals(source).filter((text) => SPANISH.test(text));
      expect(found, `${name} has Spanish in a string`).toEqual([]);
    }
  });

  it("would catch the sentence that was actually shipped", () => {
    // Pinned, because a guard nobody has seen fail is a guard nobody knows
    // works. Both quotings, since it was a plain double-quoted string that
    // shipped and a template literal that walked past the first version.
    expect(SPANISH.test("Demasiadas consultas seguidas. Espera un momento.")).toBe(true);
    expect(literals('const x = `Demasiadas consultas seguidas.`;')).toEqual([
      "Demasiadas consultas seguidas.",
    ]);
    expect(literals("const x = 'Espera un momento.';")).toEqual(["Espera un momento."]);
  });

  it("does not object to an accented game title", () => {
    // Steam relays titles verbatim, so these arrive unchanged and are ordinary
    // English-context data. The first version failed on both.
    expect(SPANISH.test("Pokémon")).toBe(false);
    expect(SPANISH.test("Señor")).toBe(false);
    expect(SPANISH.test("Café International")).toBe(false);
  });
});
