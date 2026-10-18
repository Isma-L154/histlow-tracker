/** Types for `scenes.js`, which is plain JavaScript because the browser loads it directly. */

export interface World {
  id: "cityOfTears" | "landsBetween" | "hell" | "olympus" | "frontier";
  /** Pre-renders the world's layers for a stage size; returns a painter for one frame. */
  build(width: number, height: number): (ctx: CanvasRenderingContext2D, seconds: number) => void;
}

/** `count` colours evenly along the given ones, which come back unchanged when there are already enough. */
export declare function shades(colours: readonly string[], count: number): readonly string[];

/** The height the scenes were drawn at; a taller stage adds sky above them. */
export declare const SCENE_HEIGHT: number;

export declare const WORLDS: readonly World[];
