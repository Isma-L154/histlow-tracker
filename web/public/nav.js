/**
 * Whether a click on a link belongs to the page or to the browser. Getting a
 * guard backwards turns "open in a new tab" into navigating the current one.
 *
 * @param {Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">} event
 * @returns {boolean} true when the page should handle the click itself.
 */
export function handledInPage(event) {
  if (event.defaultPrevented) return false;

  // Middle and right clicks arrive here in browsers that do not split them off.
  if (event.button !== 0) return false;

  // A modified click asks for a new tab, a new window or a download.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;

  return true;
}
