/**
 * The Content-Security-Policy as `_headers` ships it.
 *
 * `headers.test.ts` proves the Worker copies the policy faithfully; this pins
 * what the policy itself allows, because a copy of a wrong policy is still wrong.
 */

import { describe, expect, it } from "vitest";
import headers from "../public/_headers?raw";

/** The policy's directives, by name, each with its list of sources. */
function directives(): Map<string, string[]> {
  const line = headers.split("\n").find((l) => /^\s*Content-Security-Policy:/i.test(l));
  expect(line, "no Content-Security-Policy line in _headers").toBeDefined();
  const policy = line!.slice(line!.indexOf(":") + 1);
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...sources]) => [name!, sources]),
  );
}

describe("the content security policy", () => {
  it("still forbids everything by default", () => {
    expect(directives().get("default-src")).toEqual(["'none'"]);
  });

  it("lets the site load its own fonts", () => {
    expect(directives().get("font-src")).toEqual(["'self'"]);
  });

  it("no longer lets the browser load IGDB images", () => {
    // The covers only fed the upcoming-releases section, which is gone.
    expect(directives().get("img-src")).not.toContain("https://images.igdb.com");
  });
});
