/**
 * The five worlds the party walks through, as tributes to the games they
 * evoke. Each `build(width, height)` pre-renders its tiling layers once for that
 * size and returns a function that paints a frame at a given time in seconds.
 *
 * Coordinates were drawn on a 300-pixel-wide stage; `at()` maps them onto the
 * real width so a landmark keeps its place on a phone and on a wide screen.
 */

/** Seeded, so a world looks the same on every visit. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drawing helpers bound to one stage size. */
function stage(W, H) {
  const GY = H - 22;
  const at = (x) => Math.round((x * W) / 300);

  function px(g, x, y, colour, w = 1, h = 1) {
    g.fillStyle = colour;
    g.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function layer(draw) {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    draw(canvas.getContext("2d"));
    return canvas;
  }

  // Whole pixels only: a fractional offset blends the seam between the two copies.
  function blit(ctx, l, offset) {
    const x = -(((Math.round(offset) % W) + W) % W);
    ctx.drawImage(l, x, 0);
    ctx.drawImage(l, x + W, 0);
  }

  function wrap(fn) {
    for (const dx of [-W, 0, W]) fn(dx);
  }

  function bands(g, colours, y0, y1) {
    const h = (y1 - y0) / colours.length;
    colours.forEach((colour, i) => {
      const top = Math.round(y0 + i * h);
      const bottom = Math.round(y0 + (i + 1) * h);
      px(g, 0, top, colour, W, bottom - top);
      if (i < colours.length - 1) for (let x = 0; x < W; x += 2) px(g, x, bottom, colour);
    });
  }

  /** A random-walk skyline; the last 40 columns ease back so the layer tiles. */
  function ridge(g, r, colour, lo, hi, rough, fromTop = false) {
    const ys = [];
    let y = (lo + hi) / 2;
    for (let x = 0; x < W; x++) {
      y = Math.max(lo, Math.min(hi, y + (r() - 0.5) * rough));
      ys.push(y);
    }
    const ease = Math.min(40, W);
    for (let x = W - ease; x < W; x++) {
      const t = (x - (W - ease)) / ease;
      ys[x] = ys[x] * (1 - t) + ys[0] * t;
    }
    return ys.map((v, x) => {
      const top = Math.round(v);
      if (fromTop) px(g, x, 0, colour, 1, top);
      else px(g, x, top, colour, 1, H - top);
      return top;
    });
  }

  /** Rolling hills from whole-number frequencies, so they tile. */
  function hills(g, colour, base, a1, f1, a2, f2, phase) {
    const ys = [];
    for (let x = 0; x < W; x++) {
      const y = Math.round(
        base + a1 * Math.sin((2 * Math.PI * f1 * x) / W + phase) + a2 * Math.sin((2 * Math.PI * f2 * x) / W + phase * 2),
      );
      ys.push(y);
      px(g, x, y, colour, 1, H - y);
    }
    return ys;
  }

  function ground(g, r, top, top2, body, speck) {
    px(g, 0, GY, top, W, 2);
    px(g, 0, GY + 2, top2, W, 1);
    px(g, 0, GY + 3, body, W, H - GY - 3);
    const specks = Math.round((160 * W) / 300);
    for (let i = 0; i < specks; i++) px(g, Math.floor(r() * W), GY + 4 + Math.floor(r() * (H - GY - 4)), speck);
  }

  function disc(g, cx, cy, radius, colour) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) if (x * x + y * y <= radius * radius) px(g, cx + x, cy + y, colour);
    }
  }

  /** Rain, snow, embers: points that drift and wrap, placed by a seed. */
  function particles(ctx, seed, count, vx, vy, seconds, draw) {
    const r = rng(seed);
    const n = Math.round((count * W) / 300);
    for (let i = 0; i < n; i++) {
      const x0 = r() * W;
      const y0 = r() * H;
      const speed = 0.6 + r() * 0.8;
      const x = (((x0 + seconds * vx * speed) % W) + W) % W;
      const y = (((y0 + seconds * vy * speed) % H) + H) % H;
      draw(Math.round(x), Math.round(y), i);
    }
  }

  /** A soft round glow, drawn as stacked rows so it stays pixelated. */
  function glow(ctx, cx, cy, radius, colour) {
    ctx.fillStyle = colour;
    for (let y = -radius; y <= radius; y++) {
      const w = Math.round(Math.sqrt(radius * radius - y * y));
      ctx.fillRect(cx - w, cy + y, w * 2, 1);
    }
  }

  return { GY, at, px, layer, blit, wrap, bands, ridge, hills, ground, disc, particles, glow };
}

function cityOfTears(W, H) {
  const s = stage(W, H);
  const r = rng(3);
  const sky = s.layer((g) => s.bands(g, ["#05081a", "#0a1330", "#101d45", "#17295a"], 0, H));
  const towers = s.layer((g) => {
    let x = 0;
    while (x < W) {
      const w = 10 + Math.floor(r() * 16);
      const h = 40 + Math.floor(r() * 50);
      const top = s.GY - h;
      s.px(g, x, top, "#14214a", w, h);
      const spire = Math.floor(w / 2);
      for (let k = 0; k < 8; k++) s.px(g, x + spire - Math.floor(k / 3), top - 8 + k, "#14214a", 1 + 2 * Math.floor(k / 3), 1);
      for (let y = top + 6; y < s.GY - 6; y += 9) {
        s.px(g, x + 3, y, "#7fb6ff", 2, 3);
        if (w > 14) s.px(g, x + w - 5, y, "#7fb6ff", 2, 3);
      }
      x += w + 2;
    }
  });
  const roof = s.layer((g) => s.ridge(g, r, "#0a1028", 4, 16, 2.4, true));
  const floor = s.layer((g) => s.ground(g, r, "#3b4a75", "#26315a", "#1a2244", "#2b3a68"));
  const lamps = [40, 120, 200, 270].map(s.at);

  return (ctx, seconds) => {
    ctx.drawImage(sky, 0, 0);
    s.blit(ctx, towers, seconds * 6);
    for (const lamp of lamps) {
      const x = (((lamp - Math.round(seconds * 12)) % W) + W) % W;
      s.glow(ctx, x, 100, 9, "rgba(160, 210, 255, 0.1)");
      s.px(ctx, x, 82, "#46557f", 1, 14);
      s.px(ctx, x - 2, 96, "#46557f", 5, 1);
      s.px(ctx, x - 1, 97, "#d9f0ff", 3, 4);
      s.px(ctx, x, 98, "#ffffff");
    }
    s.blit(ctx, roof, seconds * 12);
    s.particles(ctx, 9, 90, -18, 120, seconds, (x, y) => s.px(ctx, x, y, "#8fb4e8", 1, 3));
    s.blit(ctx, floor, seconds * 30);
  };
}

function landsBetween(W, H) {
  const s = stage(W, H);
  const r = rng(8);
  const sky = s.layer((g) => s.bands(g, ["#221f2b", "#3c3546", "#62555e", "#8f7a70", "#c2a57e", "#e0c48e"], 0, 108));
  // The great tree stands still on the horizon while everything else passes.
  const tree = s.layer((g) => {
    const tx = s.at(262);
    for (let k = 0; k < 72; k++) {
      const w = Math.max(3, 10 - Math.floor(k / 9));
      s.px(g, tx - Math.floor(w / 2) + Math.round(Math.sin(k / 11) * 2), 108 - k, k % 6 === 0 ? "#fff1b8" : "#f2c94c", w, 1);
    }
    for (let i = 0; i < 1400; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r());
      const colour = d < 0.45 ? (r() < 0.5 ? "#fff3c4" : "#ffe28a") : r() < 0.55 ? "#f2c94c" : "#b98428";
      s.px(g, tx + Math.cos(a) * d * 44, 32 + Math.sin(a) * d * 22, colour);
    }
    for (let i = 0; i < 10; i++) {
      const sx = tx - 36 + i * 8;
      for (let k = 0; k < 22; k++) s.px(g, sx + Math.round(Math.sin(k / 3 + i) * 2), 46 + k * 1.5, i % 2 ? "#d9a83a" : "#f2c94c");
    }
  });
  const far = s.layer((g) => s.ridge(g, r, "#4a4250", 84, 100, 2.6));
  const ruins = s.layer((g) => {
    const ys = s.hills(g, "#2f2a33", 112, 3, 2, 2, 5, 0.3);
    for (const x of [40, 130, 236].map(s.at)) {
      s.wrap((dx) => {
        const y = ys[x];
        s.px(g, x + dx, y - 26, "#3d3644", 4, 26);
        s.px(g, x + dx + 16, y - 20, "#3d3644", 4, 20);
        s.px(g, x + dx, y - 28, "#3d3644", 12, 3);
      });
    }
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(r() * W);
      s.wrap((dx) => {
        s.px(g, x + dx, ys[x] - 7, "#3d3644", 2, 7);
        s.px(g, x + dx - 2, ys[x] - 5, "#3d3644", 6, 2);
      });
    }
  });
  const floor = s.layer((g) => s.ground(g, r, "#77744e", "#57553a", "#3a3628", "#4b4632"));
  const bonfire = s.at(150);

  return (ctx, seconds) => {
    ctx.drawImage(sky, 0, 0);
    ctx.drawImage(tree, 0, 0);
    s.blit(ctx, far, seconds * 4);
    s.blit(ctx, ruins, seconds * 12);
    s.blit(ctx, floor, seconds * 30);
    const x = (((bonfire - Math.round(seconds * 30)) % W) + W) % W;
    const y = s.GY;
    s.glow(ctx, x, y - 5, 8, "rgba(255, 190, 90, 0.1)");
    s.px(ctx, x - 5, y - 2, "#5a5560", 11, 2);
    s.px(ctx, x - 3, y - 3, "#3a3640", 7, 1);
    const flicker = Math.floor(seconds * 9) % 3;
    s.px(ctx, x - 3, y - 7, "#ff7a2f", 7, 4);
    s.px(ctx, x - 2 + (flicker === 0 ? -1 : 0), y - 10, "#ffb347", 5, 3);
    s.px(ctx, x - 1 + (flicker === 2 ? 1 : 0), y - 12, "#ffe28a", 2, 2);
    s.px(ctx, x, y - 18, "#8a8f96", 1, 12);
    s.px(ctx, x - 1, y - 18, "#5d6168", 3, 1);
    s.particles(ctx, 41, 24, 2, -10, seconds, (px, py, i) => s.px(ctx, px, py, i % 2 ? "#f7d56b" : "#fff1b8"));
  };
}

function hell(W, H) {
  const s = stage(W, H);
  const r = rng(13);
  const sky = s.layer((g) => s.bands(g, ["#140303", "#2e0707", "#5c0d0d", "#9a2414", "#d4521b"], 0, 112));
  const spires = s.layer((g) => {
    for (let i = 0; i < Math.round((18 * W) / 300); i++) {
      const x = Math.floor(r() * W);
      const h = 30 + Math.floor(r() * 60);
      const w = 4 + Math.floor(r() * 8);
      for (let k = 0; k < h; k++) {
        const ww = Math.max(1, Math.round((w * k) / h));
        s.wrap((dx) => s.px(g, x + dx - Math.floor(ww / 2), s.GY - h + k, "#1e0606", ww, 1));
      }
    }
  });
  const demons = s.layer((g) => {
    const ys = s.ridge(g, r, "#120303", 96, 116, 4);
    for (let i = 0; i < Math.round((7 * W) / 300); i++) {
      const x = Math.floor(r() * W);
      const y = ys[x];
      s.wrap((dx) => {
        s.px(g, x + dx - 4, y - 10, "#2a0a0a", 9, 10);
        s.px(g, x + dx - 2, y - 8, "#ff7a1a", 2, 2);
        s.px(g, x + dx + 1, y - 8, "#ff7a1a", 2, 2);
        s.px(g, x + dx - 1, y - 4, "#120303", 3, 2);
        s.px(g, x + dx - 6, y - 14, "#2a0a0a", 2, 6);
        s.px(g, x + dx + 5, y - 14, "#2a0a0a", 2, 6);
      });
    }
  });
  const floor = s.layer((g) => {
    s.ground(g, r, "#4a1a12", "#2e0d09", "#1e0806", "#3a120c");
    for (let i = 0; i < Math.round((8 * W) / 300); i++) {
      const x = Math.floor(r() * W);
      const w = 10 + Math.floor(r() * 14);
      s.wrap((dx) => {
        s.px(g, x + dx, s.GY + 6, "#ff6a13", w, 3);
        s.px(g, x + dx + 2, s.GY + 5, "#ffb347", w - 4, 1);
      });
    }
  });

  return (ctx, seconds) => {
    ctx.drawImage(sky, 0, 0);
    s.blit(ctx, spires, seconds * 5);
    s.blit(ctx, demons, seconds * 14);
    s.blit(ctx, floor, seconds * 30);
    s.particles(ctx, 21, 40, -10, -26, seconds, (x, y, i) => s.px(ctx, x, y, i % 3 ? "#ff8a2a" : "#ffd27a"));
  };
}

function olympus(W, H) {
  const s = stage(W, H);
  const r = rng(17);
  const sky = s.layer((g) => s.bands(g, ["#24407a", "#3e66ad", "#6f97d4", "#a9c6ea", "#e8dcb8", "#f6e3a6"], 0, 112));
  const peak = s.layer((g) => {
    s.ridge(g, r, "#8b93a8", 60, 96, 3.4);
    const cx = s.at(160);
    for (let k = 0; k < 52; k++) {
      const w = 4 + k * 2;
      s.px(g, cx - Math.floor(w / 2), 30 + k, k < 14 ? "#f4f2ea" : "#9aa2b8", w, 1);
    }
    s.px(g, cx - 9, 22, "#f4f2ea", 18, 2);
    for (let c = 0; c < 4; c++) s.px(g, cx - 8 + c * 5, 24, "#f4f2ea", 2, 6);
    s.px(g, cx - 10, 30, "#f4f2ea", 20, 1);
    for (let k = 0; k < 5; k++) s.px(g, cx - k * 2, 17 + k, "#f4f2ea", k * 4 + 1, 1);
  });
  const clouds = s.layer((g) => {
    for (let i = 0; i < Math.round((9 * W) / 300); i++) {
      const x = Math.floor(r() * W);
      const y = 70 + Math.floor(r() * 30);
      const w = 18 + Math.floor(r() * 26);
      s.wrap((dx) => {
        s.px(g, x + dx, y, "#ffffff", w, 4);
        s.px(g, x + dx + 4, y - 3, "#ffffff", w - 10, 3);
        s.px(g, x + dx + 2, y + 4, "#d9e3f0", w - 4, 1);
      });
    }
  });
  const temple = s.layer((g) => {
    const tx = s.at(40);
    const base = s.GY;
    s.px(g, tx, base - 4, "#d8d0bf", 92, 4);
    s.px(g, tx + 2, base - 6, "#e8e2d4", 88, 2);
    for (let c = 0; c < 8; c++) {
      s.px(g, tx + 6 + c * 11, base - 36, "#efe9db", 5, 30);
      s.px(g, tx + 9 + c * 11, base - 36, "#c9bfa9", 2, 30);
    }
    s.px(g, tx + 2, base - 40, "#e8e2d4", 88, 4);
    s.px(g, tx + 4, base - 42, "#c9a94a", 84, 2);
    for (let k = 0; k < 12; k++) s.px(g, tx + 46 - k * 4, base - 54 + k, "#efe9db", k * 8 + 1, 1);
    s.px(g, tx + 40, base - 47, "#c9a94a", 12, 2);
    for (const x of [170, 220, 262].map(s.at)) {
      s.px(g, x, base - 22, "#efe9db", 5, 22);
      s.px(g, x - 1, base - 24, "#e8e2d4", 7, 2);
      s.px(g, x + 3, base - 22, "#c9bfa9", 1, 22);
    }
  });
  const floor = s.layer((g) => {
    s.px(g, 0, s.GY, "#f2ede1", W, 2);
    s.px(g, 0, s.GY + 2, "#c9a94a", W, 1);
    s.px(g, 0, s.GY + 3, "#e2dac8", W, H - s.GY - 3);
    for (let x = 0; x < W; x += 16) s.px(g, x, s.GY + 3, "#c7bda8", 1, H - s.GY - 3);
    for (let y = s.GY + 10; y < H; y += 8) s.px(g, 0, y, "#c7bda8", W, 1);
  });

  return (ctx, seconds) => {
    ctx.drawImage(sky, 0, 0);
    s.blit(ctx, peak, seconds * 3);
    s.blit(ctx, clouds, seconds * 7);
    s.blit(ctx, temple, seconds * 14);
    s.blit(ctx, floor, seconds * 30);
    // A bolt every five seconds, lit for a quarter of a second.
    if (seconds % 5 < 0.25) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
      ctx.fillRect(0, 0, W, H);
      const bolt = rng(Math.floor(seconds / 5) + 3);
      let x = s.at(40) + bolt() * s.at(220);
      let y = 0;
      while (y < 74) {
        const nx = x + (bolt() - 0.5) * 14;
        const ny = y + 6 + bolt() * 6;
        for (let k = 0; k <= 8; k++) s.px(ctx, x + ((nx - x) * k) / 8, y + ((ny - y) * k) / 8, "#fff7c2", 2, 2);
        x = nx;
        y = ny;
      }
    }
  };
}

function frontier(W, H) {
  const s = stage(W, H);
  const r = rng(29);
  const sky = s.layer((g) => {
    s.bands(g, ["#3b2a52", "#7a3e5a", "#c45a4a", "#e8894a", "#f5b85e", "#fbd98a"], 0, 104);
    s.disc(g, s.at(60), 92, 13, "#ffe7a8");
  });
  const mesas = s.layer((g) => {
    s.px(g, 0, 92, "#8a3f3a", W, 40);
    for (const [x0, w, h] of [[20, 40, 30], [110, 24, 20], [170, 52, 36], [252, 30, 24]]) {
      const x = s.at(x0);
      s.wrap((dx) => {
        for (let k = 0; k < h; k++) {
          const spread = k < 3 ? 0 : Math.floor((k - 3) / 2);
          s.px(g, x + dx - spread, 92 - h + k, "#8a3f3a", w + spread * 2, 1);
        }
        s.px(g, x + dx, 92 - h, "#b35a44", w, 2);
        for (let k = 6; k < h; k += 5) s.px(g, x + dx + 2, 92 - h + k, "#76332f", w - 4, 1);
      });
    }
  });
  const cacti = s.layer((g) => {
    const ys = s.hills(g, "#6b4a33", 112, 3, 3, 2, 6, 0.9);
    for (let i = 0; i < Math.round((9 * W) / 300); i++) {
      const x = Math.floor(r() * W);
      const y = ys[x];
      s.wrap((dx) => {
        s.px(g, x + dx, y - 12, "#3f6b3a", 3, 12);
        s.px(g, x + dx - 3, y - 9, "#3f6b3a", 2, 5);
        s.px(g, x + dx - 3, y - 9, "#3f6b3a", 3, 2);
        s.px(g, x + dx + 4, y - 7, "#3f6b3a", 2, 4);
        s.px(g, x + dx + 3, y - 5, "#3f6b3a", 3, 2);
      });
    }
  });
  const floor = s.layer((g) => {
    s.ground(g, r, "#c28a52", "#a8723f", "#8a5a2f", "#6e4624");
    for (let x = 0; x < W; x += 30) {
      s.px(g, x, s.GY - 8, "#5a3d26", 2, 8);
      s.px(g, x - 14, s.GY - 6, "#5a3d26", 30, 1);
    }
  });

  return (ctx, seconds) => {
    ctx.drawImage(sky, 0, 0);
    s.blit(ctx, mesas, seconds * 3);
    s.blit(ctx, cacti, seconds * 12);
    s.blit(ctx, floor, seconds * 30);
  };
}

export const WORLDS = [
  { id: "cityOfTears", build: cityOfTears },
  { id: "landsBetween", build: landsBetween },
  { id: "hell", build: hell },
  { id: "olympus", build: olympus },
  { id: "frontier", build: frontier },
];
