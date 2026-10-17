/**
 * Runs the home page scene: sizes the canvas to whole pixels, walks the party
 * through the worlds in turn, and draws nothing while the scene is off screen
 * or the reader has asked for less motion.
 */

import { HEROES, drawSprite, heroRows } from "./sprites.js";
import { WORLDS } from "./scenes.js";

const HEIGHT = 150;
const GROUND = HEIGHT - 22;
const ROTATE_SECONDS = 9;
const FADE_SECONDS = 0.6;
const FADE_STEPS = 4;

/** The largest whole-number scale from 2 to 4 that keeps the stage at least 300 pixels wide. */
export function pickScale(containerWidth) {
  const scale = Math.min(4, Math.max(2, Math.floor(containerWidth / 300)));
  return { scale, width: Math.ceil(containerWidth / scale) };
}

/**
 * A frame loop over an injected scheduler. Restarting abandons any frame still
 * queued from before, so a stop and a start never leave two loops running.
 */
export function createLoop({ draw, schedule, reducedMotion }) {
  let generation = 0;
  return {
    start() {
      generation += 1;
      if (reducedMotion) {
        draw(0);
        return;
      }
      const mine = generation;
      const tick = (ms) => {
        if (mine !== generation) return;
        draw(ms / 1000);
        schedule(tick);
      };
      schedule(tick);
    },
    stop() {
      generation += 1;
    },
  };
}

/** The party's x positions, centred, with room for all five on a narrow stage. */
function partyPositions(width) {
  const spacing = Math.min(36, Math.floor((width - 32) / 4));
  const start = Math.round((width - (16 + spacing * 4)) / 2);
  return HEROES.map((_hero, i) => start + i * spacing);
}

function drawParty(ctx, width, seconds) {
  const step = Math.floor(seconds * 6) % 2;
  partyPositions(width).forEach((x, i) => {
    const frame = (step + i) % 2;
    const rows = heroRows(HEROES[i], frame);
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(x + 3, GROUND + 1, 10, 1);
    drawSprite(ctx, rows, HEROES[i].palette, x, GROUND - rows.length + frame);
  });
}

/** Black over the scene for a stepped fade: up to full at the midpoint, then back down. */
function fadeAlpha(progress) {
  const half = progress < 0.5 ? progress / 0.5 : (1 - progress) / 0.5;
  return Math.ceil(Math.max(0, half) * FADE_STEPS) / FADE_STEPS;
}

export function mountWorld(canvas, dots) {
  const ctx = canvas.getContext("2d");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let size = null;
  let painters = [];
  let current = 0;
  let shownSince = null;
  let fadeStart = null;

  dots.replaceChildren(...WORLDS.map(() => document.createElement("i")));
  const markDots = () => [...dots.children].forEach((dot, i) => dot.classList.toggle("is-on", i === current));
  markDots();

  // Built on first use: five worlds' layers at once would delay the first frame.
  const painter = (i) => (painters[i] ??= WORLDS[i].build(size.width, HEIGHT));

  function draw(seconds) {
    shownSince ??= seconds;
    if (!reducedMotion && fadeStart === null && seconds - shownSince >= ROTATE_SECONDS) fadeStart = seconds;

    let alpha = 0;
    if (fadeStart !== null) {
      const progress = (seconds - fadeStart) / FADE_SECONDS;
      if (progress >= 0.5 && shownSince < fadeStart) {
        current = (current + 1) % WORLDS.length;
        shownSince = seconds;
        markDots();
      }
      if (progress >= 1) fadeStart = null;
      else alpha = fadeAlpha(progress);
    }

    painter(current)(ctx, seconds);
    drawParty(ctx, size.width, seconds);
    if (alpha > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
      ctx.fillRect(0, 0, size.width, HEIGHT);
    }
  }

  const loop = createLoop({ draw, schedule: requestAnimationFrame, reducedMotion });

  function resize() {
    const container = canvas.parentElement.clientWidth;
    const next = pickScale(container);
    if (size && next.width === size.width && next.scale === size.scale) return;
    size = next;
    painters = [];
    canvas.width = size.width;
    canvas.height = HEIGHT;
    canvas.style.width = `${size.width * size.scale}px`;
    canvas.style.height = `${HEIGHT * size.scale}px`;
    // Wider than its container by under one scaled pixel: centre the overhang.
    canvas.style.marginLeft = `${Math.floor((container - size.width * size.scale) / 2)}px`;
    ctx.imageSmoothingEnabled = false;
    if (reducedMotion) loop.start();
  }

  resize();
  new ResizeObserver(resize).observe(canvas.parentElement);
  new IntersectionObserver(([entry]) => (entry.isIntersecting ? loop.start() : loop.stop())).observe(canvas);
}
