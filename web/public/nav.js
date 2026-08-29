/**
 * Whether a click on a link belongs to this page or to the browser.
 *
 * Split out of the handler so it can be tested. It is the most fragile logic
 * in the client: four guards, and getting any one of them backwards silently
 * turns "open this in a new tab" into "navigate the tab I was reading", which
 * is the kind of thing nobody reports and everybody notices.
 *
 * @param {Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">} event
 * @returns {boolean} true when the page should handle the click itself.
 */
export function handledInPage(event) {
  // Something upstream already decided what this click means.
  if (event.defaultPrevented) return false;

  // Only the primary button. Middle click opens a tab and right click opens a
  // menu, and both arrive here in browsers that do not split them off.
  if (event.button !== 0) return false;

  // A modified click asks for a second tab, a new window, or a saved file -
  // never for this page to change underneath the reader.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

  return true;
}
