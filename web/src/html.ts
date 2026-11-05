/**
 * The only tools this project uses to write HTML by hand. Game names and
 * achievement text come from Steam and are untrusted, so nothing reaches a
 * document without passing through one of these.
 */

/** Escapes text for an element's content. */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes text for a double- or single-quoted attribute. */
export function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface Rewrite {
  html: string;
  /** Tags the shell no longer contains, so an edited shell cannot fall back silently. */
  missed: string[];
}

/**
 * Replaces `pattern` with `tag`, taking the replacement literally.
 *
 * A string replacement reads `$&`, `` $` ``, `$'` and `$1` as instructions, and
 * escaping cannot prevent it: its own `&amp;` supplies the `&` that turns a
 * `$` in a game title into `$&`. A replacer function's result is never scanned.
 */
export function put(into: Rewrite, name: string, pattern: RegExp, tag: string): Rewrite {
  if (!pattern.test(into.html)) {
    into.missed.push(name);
    return into;
  }
  into.html = into.html.replace(pattern, () => tag);
  return into;
}
