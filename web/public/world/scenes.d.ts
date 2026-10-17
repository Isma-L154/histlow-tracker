/** Types for `scenes.js`, which is plain JavaScript because the browser loads it directly. */

export interface World {
  id: "cityOfTears" | "landsBetween" | "hell" | "olympus" | "frontier";
  /** Pre-renders the world's layers for a stage size; returns a painter for one frame. */
  build(width: number, height: number): (ctx: CanvasRenderingContext2D, seconds: number) => void;
}

export declare const WORLDS: readonly World[];
