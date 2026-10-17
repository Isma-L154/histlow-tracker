/**
 * The party that walks across the home page: tributes, drawn here pixel by
 * pixel, to heroes of well-known games. Each row is 16 pixels; `.` is
 * transparent and every other letter is a colour from the hero's palette.
 */

/** Two walking frames shared by the heroes with ordinary legs. */
const LEGS = {
  a: ["....kllk.kllk...", "....kllk.kllk...", "...kllk...kllk..", "...kffk...kffk.."],
  b: [".....kllkllk....", ".....kllkllk....", ".....kllkllk....", "....kffkkffk...."],
};

export const HEROES = [
  {
    id: "sunKnight",
    palette: {
      k: "#0d0d10", m: "#b9c0c8", M: "#6e7680", T: "#efe9dc", o: "#f0a030", O: "#c96f12",
      b: "#5a3d26", s: "#dfe6ee", h: "#6b4a2b", l: "#6e7680", f: "#0d0d10",
    },
    body: [
      "................", ".....kkkkk......", "....kmmmmmk.....", "....kmmmmmk.....",
      "....kmkkkmk.....", "....kmmkmmk.....", "....kMMMMMk.....", "..kkkTTTTTkkk...",
      ".kmkTToooTTkmk..", ".kmkTooOooTkmks.", ".kmkTToooTTkmks.", "..kkTTTTTTTkk.s.",
      "...kbbbbbbbk..h.", "...kTTTTTTTk....",
    ],
    legs: LEGS,
  },
  {
    id: "blackMage",
    palette: {
      k: "#0d0d10", h: "#d6b46a", H: "#7a4a22", F: "#07070b", y: "#ffd94a", b: "#3a5bbf",
      B: "#26398a", g: "#8a5a2b", o: "#e04a4a", l: "#26398a", f: "#5a3d26",
    },
    body: [
      "......k.........", "......kk........", ".....khk........", ".....khhk.......",
      "....khhhk.......", "....khhhhk......", "...kHHHHHHk.....", ".kkhhhhhhhhkk...",
      ".khhhhhhhhhhhk..", "...kFFFFFFk..o..", "...kFyFFyFk..g..", "...kFFFFFFk..g..",
      "..kbbbbbbbbk.g..", ".kbBbbbbbbBbkg..", ".kbbbbbbbbbbkg..", "..kbbbbbbbbk.g..",
    ],
    legs: LEGS,
  },
  {
    id: "swordsman",
    palette: {
      k: "#14101c", g: "#3fa34d", G: "#2a6b33", y: "#f2c94c", t: "#f2c79b", b: "#7a4a22",
      B: "#c9a45a", w: "#e6ecf2", l: "#e9e4dc", f: "#7a4a22",
    },
    body: [
      "......kkk.......", ".....kgggk......", "....kgggggk.....", "...kggggggggk...",
      "...kyyyyyyyGGk..", "..tkyttttyk.kGk.", "..ktktkttktk..kk", "...kttttttk.....",
      "..kkgggggggkk...", ".kbBkgggggkkw...", ".kbbkGbbbGk.w...", ".kBbkgggggk.w...",
      "..kk.kgggk......",
    ],
    legs: LEGS,
  },
  {
    id: "warrior",
    palette: {
      k: "#120c0a", s: "#ddd6cc", r: "#b22a2a", b: "#3a2a22", a: "#9ec7e0", h: "#6b4a2b",
      L: "#5a3d26", l: "#5a3d26", f: "#120c0a",
    },
    body: [
      ".....kkkkk......", "....kssrssk.....", "....kssrssk.....", "....kkrskkk.....",
      "....ksrsssk...a.", "....kbbbbbk..aaa", "..kkkbbbbbkkk.h.", ".ksssrssssssk.h.",
      ".kssssrsssssk.h.", ".kskkkkrkkksksh.", "..kkLLLLLLkk..h.", "...kLLLLLLk.....",
    ],
    legs: LEGS,
  },
  {
    id: "cowboy",
    palette: {
      k: "#120c0a", H: "#6b4a2b", t: "#e0b48c", d: "#8a6a52", v: "#5a3d26", b: "#7d93ad",
      L: "#3b2a1d", y: "#d9b54a", l: "#3d4e66", f: "#4a3220",
    },
    body: [
      ".....kkkkk......", "....kHHHHHk.....", "..kkHHHHHHHkk...", "..kkkkkkkkkkk...",
      "....kttttttk....", "....ktkttktk....", "....kdtttdtk....", "...kkkddddkkk...",
      "..kvbvbbbbvbvk..", "..kvbvbbbbvbvk..", "..ktkLLyLLLktk..", "...kLLLLLLLk....",
    ],
    legs: LEGS,
  },
];

/** The rows to draw for one walking frame: the body, then that frame's legs. */
export function heroRows(hero, frame) {
  return hero.body.concat(frame === 0 ? hero.legs.a : hero.legs.b);
}

/** Paints sprite rows one pixel per character, skipping `.` and unknown letters. */
export function drawSprite(ctx, rows, palette, x, y) {
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      const colour = palette[row[i]];
      if (colour === undefined) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(x + i, y + j, 1, 1);
    }
  });
}
