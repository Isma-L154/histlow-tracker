/**
 * Which clicks the page keeps, and which it hands back to the browser.
 *
 * This is the one piece of the client covered by the automated suite. It is
 * also the piece worth covering: the brand is a real link, so a broken handler
 * degrades to a full page load, but a handler that swallows a modified click
 * takes the reader's tab away from what they were reading.
 */

import { describe, expect, it } from "vitest";
import { handledInPage } from "../public/nav.js";

/** A plain left click, which is the only kind the page should keep. */
const PLAIN = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

describe("handledInPage", () => {
  it("keeps a plain left click", () => {
    expect(handledInPage(PLAIN)).toBe(true);
  });

  it.each([
    ["cmd/meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
  ])("leaves a %s click to the browser", (_name, modifier) => {
    // Each of these asks for a new tab, a new window, or a saved file. None of
    // them asks for this page to change.
    expect(handledInPage({ ...PLAIN, ...modifier })).toBe(false);
  });

  it.each([
    ["middle", 1],
    ["right", 2],
  ])("leaves a %s-button click to the browser", (_name, button) => {
    expect(handledInPage({ ...PLAIN, button })).toBe(false);
  });

  it("yields to a handler that already acted", () => {
    expect(handledInPage({ ...PLAIN, defaultPrevented: true })).toBe(false);
  });
});
