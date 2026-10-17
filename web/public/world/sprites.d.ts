/** Types for `sprites.js`, which is plain JavaScript because the browser loads it directly. */

export interface Hero {
  id: "sunKnight" | "blackMage" | "swordsman" | "warrior" | "cowboy";
  /** Letter to CSS colour; `.` is never a key, it is transparent. */
  palette: Readonly<Record<string, string>>;
  body: readonly string[];
  legs: { readonly a: readonly string[]; readonly b: readonly string[] };
}

export declare const HEROES: readonly Hero[];

export declare function heroRows(hero: Hero, frame: 0 | 1): string[];

export declare function drawSprite(
  ctx: CanvasRenderingContext2D,
  rows: readonly string[],
  palette: Readonly<Record<string, string>>,
  x: number,
  y: number,
): void;
