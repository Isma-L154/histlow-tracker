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
import client from "../public/app.js?raw";

/**
 * Every module in the Worker, enumerated rather than listed.
 *
 * The first version named five of eleven by hand. That is the shape `http.ts`
 * argues against a few lines from where it is explained, for `LOGGABLE`: an
 * allowlist fails open, and the day somebody adds a module its prose is
 * uncovered and nothing says so.
 */
const SOURCES = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
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
    // Twelve today - eleven modules and `env.d.ts`. A floor below that let a
    // deleted module clear it, and the pattern is recursive because the day a
    // helper lands in `src/lib/` a non-recursive one would leave it uncovered:
    // the allowlist-fails-open shape this whole block argues against.
    expect(Object.keys(SOURCES).length).toBeGreaterThanOrEqual(12);
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

describe("a throttled completion-time request", () => {
  it("does not tell the reader about a profile lookup they never made", async () => {
    // `/api/time/:id` borrows the profile limiter, for a reason written where
    // it borrows it - but sharing a limiter is not a reason to share a
    // sentence. It answered "Too many profile lookups" on a route that has
    // nothing to do with a profile, and no test said which key it used, so
    // pointing it back at the wrong one passed everything.
    let limited: Response | null = null;
    for (let i = 0; i < 20 && !limited; i++) {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${BASE}/api/time/${367520 + i}`, { headers: { "CF-Connecting-IP": "203.0.113.60" } }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      if (response.status === 429) limited = response;
    }

    expect(limited, "the limit never tripped, so this proves nothing").not.toBeNull();
    const body = (await limited!.json()) as { reason?: string; error: string };
    expect(body.reason).toBe("time.tooMany");
    expect(body.error).toBe(DICTIONARY.en["time.tooMany"]);
  });
});

describe("translatable errors", () => {
  it("name a key that exists in every language", () => {
    // `known()` looks the prose up, so a key with no entry ships the key itself
    // as the sentence - a reader seeing `profile.tooMany` where a sentence
    // should be.
    //
    // Matching `known(<number>, "<key>")` was the first attempt and it read
    // three of five call sites. It missed both dynamic ones, including the
    // only site that can pass an arbitrary key:
    //
    //   known(error.status, error.reason)
    //
    // Today that is safe by accident - one `SteamError` in the codebase
    // carries a reason. Adding a second with an unknown key would have shipped
    // it as prose, and the count check would still have passed at three.
    //
    // So this looks for keys rather than for call shapes: any literal that
    // reads as a dictionary key, in any module, whose prefix the dictionary
    // actually uses. That covers `known`, `new SteamError`, a ternary fallback
    // and anything not yet written.
    const prefixes = new Set(Object.keys(DICTIONARY.en).map((key) => key.split(".")[0]!));
    const found = new Set<string>();

    for (const [name, source] of Object.entries(SOURCES)) {
      for (const text of literals(source)) {
        // A key built at run time cannot be checked here. There is one - the
        // profile parse reason - and it checks itself against the dictionary
        // before using it, with `profile.default` when the key is unknown.
        if (text.includes("${")) continue;

        const dot = text.indexOf(".");
        if (dot < 1 || !prefixes.has(text.slice(0, dot))) continue;
        found.add(text);
        for (const language of LANGUAGES) {
          expect(DICTIONARY[language][text], `${name} names ${text}, missing from ${language}`).toBeTruthy();
        }
      }
    }

    // Guards the guard: a regex that matched nothing would assert nothing.
    expect(found.size, "no dictionary keys found in the Worker at all").toBeGreaterThan(4);
  });

  it("name a key even when the prefix is new", () => {
    // The check above keys off prefixes the dictionary already uses, so a
    // reason with an entirely new prefix - `steam.down`, say - is invisible to
    // it. That is not hypothetical: `known(error.status, error.reason)` passes
    // whatever a `SteamError` was built with, straight to the reader.
    //
    // So the reason argument is read where it is written. Fourth positional,
    // after the message, the status and the upstream status.
    const reasons: string[] = [];
    for (const source of Object.values(SOURCES)) {
      for (const call of code(source).matchAll(/new SteamError\(([^)]*)\)/g)) {
        const parts = call[1]!.split(",");
        const fourth = parts[3]?.trim();
        if (fourth?.startsWith('"')) reasons.push(fourth.slice(1, -1));
      }
    }

    expect(reasons.length, "no SteamError carries a reason - has the shape changed?").toBeGreaterThan(0);
    for (const reason of reasons) {
      for (const language of LANGUAGES) {
        expect(DICTIONARY[language][reason], `SteamError names ${reason}, missing from ${language}`).toBeTruthy();
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

describe("an address with nothing at it", () => {
  it("does not tell the reader their game has no achievements", async () => {
    // It borrowed `error.404`, whose text is "This game has no achievements on
    // Steam, or that id does not exist." A Spanish reader who mistyped an API
    // path was told something about their game. Both keys are real, so the key
    // check above is happy either way - only asking the route can tell.
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${BASE}/api/nothing-here`), env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { reason?: string };
    expect(body.reason).toBe("error.noRoute");
  });
});

describe("errors with no key", () => {
  it("carry a status the client can translate", () => {
    // `problem()` sends prose and no key, so the client falls back to a table
    // keyed on the status. That is fine only for statuses the table covers -
    // and it had no entry for 405 or 500, so those reached the reader in
    // English whatever language the page was in. The comment on `problem()`
    // asserted the opposite, which is how it went unnoticed.
    //
    // Reads the table from the client rather than restating it, so adding an
    // entry there is enough.
    const table = /const ERROR_KEYS = \{([^}]*)\}/.exec(client);
    expect(table, "ERROR_KEYS has moved or been renamed").not.toBeNull();
    const covered = new Set([...table![1]!.matchAll(/(\d{3})\s*:/g)].map((m) => m[1]!));
    expect(covered.size, "no statuses parsed out of ERROR_KEYS").toBeGreaterThan(2);

    const untranslatable: string[] = [];
    for (const [name, source] of Object.entries(SOURCES)) {
      // A status computed at run time cannot be checked here. The one that is
      // - `problem(error.status, error.message)` - relays a `SteamError`, and
      // those carry 404 and 502, both covered.
      for (const call of code(source).matchAll(/\bproblem\(\s*(\d{3})\s*,/g)) {
        if (!covered.has(call[1]!)) untranslatable.push(`${name}: problem(${call[1]}, …)`);
      }
    }

    expect(untranslatable, "give it a key with known(), or add the status to ERROR_KEYS").toEqual([]);
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
    // Two signals. The word list is the weak one; this is the broad one, and
    // it costs nothing: the site already holds a few hundred Spanish sentences
    // and any of them appearing in the Worker is the fault exactly.
    //
    // It matters because the word list is thinner than it looks. Two of the
    // dictionary's own Spanish error strings - "Escribe al menos dos
    // caracteres para buscar." and "Steam no está respondiendo ahora mismo." -
    // carry none of the listed words and would have walked straight past it.
    const spanishText = new Set(Object.values(DICTIONARY.es));

    for (const [name, source] of Object.entries(SOURCES)) {
      const found = literals(source).filter((text) => SPANISH.test(text) || spanishText.has(text));
      expect(found, `${name} has Spanish in a string`).toEqual([]);
    }
  });

  it("would catch a Spanish string the word list does not know", () => {
    // Pinned, because the broad signal is the half that generalises.
    const unlisted = DICTIONARY.es["error.400"]!;
    expect(SPANISH.test(unlisted), "the word list has learned this one").toBe(false);
    expect(new Set(Object.values(DICTIONARY.es)).has(unlisted)).toBe(true);
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
