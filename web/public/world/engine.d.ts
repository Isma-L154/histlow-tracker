/** Types for `engine.js`, which is plain JavaScript because the browser loads it directly. */

export declare function pickScale(
  containerWidth: number,
  containerHeight: number,
): { scale: number; width: number; height: number };

export declare function createLoop(options: {
  draw: (seconds: number) => void;
  schedule: (callback: (ms: number) => void) => unknown;
  reducedMotion: boolean;
}): { start(): void; stop(): void };

export declare function mountWorld(canvas: HTMLCanvasElement, dots: HTMLElement): void;
