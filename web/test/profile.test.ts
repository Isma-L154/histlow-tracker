/**
 * Reading whatever someone pasted into the profile panel.
 *
 * Pure, and the whole reason the parsing was separated from the lookup: what a
 * person has to hand varies enormously, and every shape of it can be checked
 * here without touching Steam.
 */

import { describe, expect, it } from "vitest";
import { MAX_INPUT, parseProfile } from "../src/profile.ts";

describe("things people actually have to hand", () => {
  it.each([
    ["a full profile URL with a custom name", "https://steamcommunity.com/id/someName/", "vanity", "someName"],
    ["the same without the trailing slash", "https://steamcommunity.com/id/someName", "vanity", "someName"],
    ["the same without the scheme", "steamcommunity.com/id/someName", "vanity", "someName"],
    ["a full profile URL with an id", "https://steamcommunity.com/profiles/76561198000000000/", "id", "76561198000000000"],
    ["the bare custom name", "someName", "vanity", "someName"],
    ["the bare id", "76561198000000000", "id", "76561198000000000"],
  ])("reads %s", (_name, input, kind, value) => {
    expect(parseProfile(input)).toEqual({ kind, value });
  });

  it.each([
    ["surrounding whitespace", "  76561198000000000  "],
    ["a newline from a sloppy copy", "\n76561198000000000\n"],
  ])("survives %s", (_name, input) => {
    expect(parseProfile(input)).toEqual({ kind: "id", value: "76561198000000000" });
  });

  it("keeps the query string out of the name", () => {
    expect(parseProfile("https://steamcommunity.com/id/someName?snr=1_2_3")).toEqual({
      kind: "vanity",
      value: "someName",
    });
  });

  it("keeps a fragment out of the name", () => {
    expect(parseProfile("https://steamcommunity.com/id/someName#top")).toEqual({
      kind: "vanity",
      value: "someName",
    });
  });

  it("decodes an escaped name", () => {
    expect(parseProfile("https://steamcommunity.com/id/some%5FName")).toEqual({
      kind: "vanity",
      value: "some_Name",
    });
  });

  it("trusts the shape over the path it came in", () => {
    // People type these by hand. An id under /id/ is still an id.
    expect(parseProfile("https://steamcommunity.com/id/76561198000000000")).toEqual({
      kind: "id",
      value: "76561198000000000",
    });
  });
});

describe("things that are not a profile", () => {
  it.each([
    ["nothing", ""],
    ["only spaces", "   "],
    ["an id one digit short", "7656119800000000"],
    ["an id one digit long", "765611980000000000"],
    ["a name with a space", "some name"],
    ["a name that is one character", "a"],
    ["a name with a symbol", "some!name"],
    ["a link this does not understand", "https://example.com/whoever"],
    ["a bare domain", "steamcommunity.com"],
    ["something not an id under /profiles/", "https://steamcommunity.com/profiles/notanid"],
  ])("refuses %s", (_name, input) => {
    expect(parseProfile(input).kind).toBe("invalid");
  });

  it("refuses an input longer than the cap", () => {
    // Bounded before Steam sees it. An unbounded parameter forwarded upstream
    // is free amplification against a quota this project cannot afford to lose.
    expect(parseProfile("a".repeat(MAX_INPUT + 1)).kind).toBe("invalid");
  });

  it("refuses a malformed escape rather than throwing", () => {
    // `decodeURIComponent` throws on this, and a bad paste is not a 500.
    expect(parseProfile("https://steamcommunity.com/id/%FF%FE").kind).toBe("invalid");
  });

  it("says something different for each way of being wrong", () => {
    // The panel shows this. "That is not a profile" for an empty box and for a
    // name Steam has never heard of would be two different problems wearing
    // one message.
    const reasons = new Set(
      ["", "a".repeat(MAX_INPUT + 1), "https://example.com/x", "some name"].map(
        (input) => (parseProfile(input) as { reason: string }).reason,
      ),
    );
    expect(reasons.size).toBeGreaterThan(1);
  });
});

describe("nothing gets past the bounds", () => {
  it.each([
    ["a name at the maximum length", "a".repeat(32), "vanity"],
    ["a name one character too long", "a".repeat(33), "invalid"],
    ["a name at the minimum length", "ab", "vanity"],
  ])("%s", (_name, input, kind) => {
    expect(parseProfile(input).kind).toBe(kind);
  });

  it("never returns a value Steam would reject", () => {
    // Whatever comes back as a vanity name is about to be put in a URL, so it
    // has to be safe there by construction rather than by escaping later.
    const inputs = [
      "someName",
      "https://steamcommunity.com/id/a-b_c/",
      "  Some_Name-9  ",
      "https://steamcommunity.com/id/x%2Fy",
      "https://steamcommunity.com/id/../../etc",
    ];
    for (const input of inputs) {
      const parsed = parseProfile(input);
      if (parsed.kind === "vanity") expect(parsed.value).toMatch(/^[A-Za-z0-9_-]{2,32}$/);
      if (parsed.kind === "id") expect(parsed.value).toMatch(/^\d{17}$/);
    }
  });
});

describe("a number that is not a SteamID64", () => {
  it.each(["7656119800000000", "765611980000000000", "123"])(
    "refuses %s with a reason about its length",
    (input) => {
      // Steam does allow a numeric custom URL, so this is not impossible. But
      // someone typing sixteen digits into a box labelled SteamID64 has
      // miscounted, and saying so beats honouring a case that essentially
      // never happens.
      const parsed = parseProfile(input);
      expect(parsed.kind).toBe("invalid");
      expect((parsed as { reason: string }).reason).toBe("wrong length for an id");
    },
  );

  it("still honours a numeric custom name when the URL says it is one", () => {
    // `/id/` is unambiguous about what follows it, so the escape hatch exists.
    expect(parseProfile("https://steamcommunity.com/id/1234")).toEqual({ kind: "vanity", value: "1234" });
  });
});
