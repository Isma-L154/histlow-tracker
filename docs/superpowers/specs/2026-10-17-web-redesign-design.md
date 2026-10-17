# HowToAchieve redesign — design

*17 October 2026. Covers issue #146 and the implementation issues that follow it.*

The site works, but it looks like every other generated dark dashboard: a
centred hero, pill buttons, identical rounded cards, a blue accent and the
system font. This redesign gives it an identity of its own, taken from the thing
it is about: video games. Every decision below was made by the owner while
looking at working mockups; the ones marked *builder's call* were not, and can
be revisited.

## Intent

Opening the site should feel like switching on a console. The home page is a
living pixel-art world with a party of heroes walking through famous game
settings, and every other page is built from the same pieces: menu windows, a
blinking cursor, pixel lettering. The game's own art and the achievement icons
stay sharp and full resolution; the pixel style frames the content, it never
degrades it.

## Goals

- A home page that is memorable on first sight and still gets a visitor to a
  game in one step: the search box stays the obvious action.
- A game page that makes rarity readable at a glance and shows a player's own
  progress when a Steam profile is saved.
- One visual system across home, game page, profile panel, search results,
  the 404 page and the Terms and Privacy pages.
- Every behaviour the site has today keeps working: search, language toggle,
  profile lookup and its outside-click and Escape closing, filters, how-to
  answers with sources and disclaimer, completion time, Steam links, link
  previews.

## Non-goals

- No new data sources and no new API routes.
- No runtime dependencies and no build step in `web/`, as today.
- No change to how answers are generated or cached.

## Anti-goals

- Pixelating the game's art or the achievement icons. Tried and rejected: the
  owner wants them at their real resolution.
- Anything that reads as "generated": gradients for decoration, purple
  accents, glassmorphism, pill buttons, the system font.
- Motion that gets in the way: the search box must stay readable over every
  scene, and reduced-motion users get a still frame.

## Decisions taken with the owner

### Visual system

- **Palette: neutral.** Black page, windows with a 4 px off-white border
  (`#F2ECE2`), a 4 px black ring outside it and a 6 px radius; white text,
  muted text `#BDBDBD`, cursor and headings white. Colour comes only from the
  game art and the rarity tiers. (Crimson, gold and steel-blue variants were
  compared and set aside.)
- **Type:** Press Start 2P for labels, numbers and titles; Pixelify Sans for
  everything that is read (descriptions, steps, hints), with ligatures off
  because its `fi` ligature reads as a stray glyph. Both are self-hosted (see
  Assets).
- **Pieces reused everywhere:** the window, the `▶` cursor (an animated CSS
  triangle on the active item), segmented bars (20 cells) for "held by", and
  pixel-skull pips for difficulty.

### Home page

- Full-width hero: a `<canvas>` drawn at a low internal resolution and scaled up
  by a whole number without smoothing, so every art pixel stays square.
- **Five heroes walking in a line**, drawn pixel by pixel in code as tributes,
  not copies: a sun knight (Dark Souls), a black mage (Final Fantasy), a
  green-capped swordsman (Zelda), a pale warrior with a red stripe and an axe
  (God of War), and a cowboy (Red Dead Redemption 2). Two-frame walk cycles.
- **Five worlds** that scroll behind them in parallax and rotate every 9 s with a
  stepped fade to black:
  1. City of Tears — gothic blue towers, hanging lamps, constant rain.
  2. The Lands Between — dusk sky, the golden Erdtree, ruins and graves, a
     bonfire with a sword in it, golden motes.
  3. Hell — red sky, rock spires, demon heads with glowing eyes, lava, embers.
  4. Olympus — snowy peak with a temple, drifting clouds, a marble temple and
     floor, a lightning bolt every 5 s.
  5. The Frontier — sunset, red mesas, cacti, a fence.
- **No world name is shown.** Small square dots show which world is current.
- Over the scene: the pixel logo, the one-line description, and the search box
  in a solid window. Below the hero: the four example games as menu items.
- **The "most anticipated" section is removed**, with everything that only
  exists to feed it (see Removals).

### Game page

- **Banner:** the game's `library_hero.jpg` with its transparent `logo.png` laid
  over the left side, both full resolution from Steam's CDN.
- **Game panel:** achievement count, difficulty as ten skull pips plus its
  label, time to 100 %, and links to Steam guides and the store page.
- **Progress panel, with a saved profile:** "22 / 63", percentage, a 63-cell
  experience bar, and the rarest achievement the player holds. **Without a
  profile** the same slot invites them to save one.
- **Tabs:** ALL always; MISSING and UNLOCKED only with a profile (today's
  filters, restyled).
- **Achievements grouped into five loot tiers** by share of players holding
  them, each with a header (gem, name, range, count) and a coloured item slot
  around every icon:

  | Tier | Held by | Colour |
  |---|---|---|
  | Legendary | under 5 % | `#F2B33D` |
  | Epic | 5 % to under 10 % | `#B06EF0` |
  | Rare | 10 % to under 25 % | `#4FA3F7` |
  | Uncommon | 25 % to under 50 % | `#5FD06A` |
  | Common | 50 % and over | `#A8A8A8` |

  Inside a tier the order stays rarest first.
- **With a profile:** an unlocked row shows UNLOCKED and its date; a locked one
  shows NOT YET, its slot border goes grey and the icon becomes Steam's locked
  version (`iconLocked`).
- **How-to:** opening an achievement shows the steps in an RPG dialogue box,
  with the black mage's portrait as narrator, the source guides credited
  underneath, and today's disclaimer and "not explained" states kept.

### Profile panel

The PLAYER window opened from the top bar: label, hint, field, SAVE and REMOVE
as cursor menu items, status as a dialogue line, the "Where do I find this?"
help. It keeps today's behaviour, including closing on an outside click or
Escape. With a saved profile the top bar shows the profile name instead of
PROFILE.

### Publishing the tribute characters

The heroes and worlds evoke characters and settings owned by others. The owner
was told a takedown notice is possible and accepted the risk: this is a personal
project and removal would be acceptable. Two consequences:

- The Terms gain a section saying the home-page characters and worlds are
  original pixel-art tributes, not official material, unaffiliated with and not
  endorsed by the rights holders, whose characters and trademarks remain theirs;
  and that any rights holder who asks will have them removed promptly through
  the contact address.
- The Privacy page is reviewed against the new pages (see Removals).

## Content and security changes

- **CSP:** add `font-src 'self'` (today fonts fall to `default-src 'none'`).
  Remove `https://images.igdb.com` from `img-src` once the upcoming section is
  gone, since nothing in the browser loads from it any more. `deploy-web.yml`
  already compares the static and Worker policies, so no change is needed there.
- **Removals:** the upcoming-releases section in `index.html`, `app.js` and
  `styles.css`; the `/api/upcoming` route; `IgdbClient.upcoming` and the types
  and tests only it uses; `features.upcoming` in `/api/health`; their strings in
  `i18n.js`. IGDB stays for completion time, which runs in the Worker.
- **Privacy:** drop IGDB from "Who else sees you", since the browser no longer
  loads its covers; check every other statement still holds.
- **Translations:** every new interface string ships in English and Spanish, as
  today. Names, titles and guide text stay data.
- **Security baseline:** no new routes, inputs or third parties. The only
  control that changes is the CSP, and it gets stricter on images. The one new
  piece of browser storage is the profile's display name (see Builder's calls),
  which Privacy must list.

## Assets

- Fonts: Press Start 2P and Pixelify Sans as WOFF2 in `web/public/fonts/`, each
  with its SIL Open Font License file, loaded with `font-display: swap`.
- Sprites and scenes are code: palette-indexed string rows and drawing
  functions. No image files, so nothing to license or optimise.
- Game art: `library_hero.jpg`, `logo.png`, `header.jpg`, `icon` and
  `iconLocked` from Steam's CDN, all already covered by `img-src`.

## Testing

- **Unit (vitest):** the tier of a percentage, at every boundary; every sprite
  row the same width and every palette key it uses defined; the CSP carries
  `font-src 'self'` and no longer allows IGDB images; every new key present in
  both languages (the existing i18n test); `styles.test.ts` keeps passing.
- **Browser, before merge:** home on desktop and at 375 px, each world, the
  reduced-motion still frame; game page with and without a profile, a game with
  hidden achievements, one without a `library_hero` or `logo`, and one with
  over 100 achievements; profile panel open, save, remove, outside click,
  Escape; both languages; Terms, Privacy and 404.
- **After merge:** `deploy-web.yml`'s production checks.

## Builder's calls

These were not discussed with the owner; each is the simplest reasonable choice.

- **Scaling:** the canvas keeps a fixed internal height of 150 px and an internal
  width of the container width divided by the scale. The scale is a whole
  number from 2 to 5, picked so the hero is roughly 300–600 px tall. Scenes are
  generated for that width.
- **Narrow screens:** at 2× on a 375 px phone the hero is 300 px tall; the logo
  shrinks, the search box spans the width, and all five heroes still fit.
- **Animation:** `requestAnimationFrame` with an IntersectionObserver that stops
  it while the hero is off screen. The canvas is decorative (`aria-hidden`).
- **Tier length:** each tier shows its first 5 achievements and a
  "▼ N MORE" button for the rest; a button, so it is keyboard reachable.
- **Missing percentages:** an achievement Steam reports no percentage for goes
  in a final "No data" group, in grey.
- **Filtered tabs:** MISSING and UNLOCKED keep the tier grouping and hide a tier
  left empty by the filter.
- **Locked icons:** Steam sometimes returns an empty `iconLocked`; then the
  normal icon is shown greyed with a CSS filter.
- **Rows on narrow screens:** the icon, name and description stay on one line;
  the state and the "held by" bar move underneath.
- **Profile name in the top bar:** today only the SteamID64 is stored, and the
  name is known only right after saving. The display name is stored next to it
  in `localStorage` and listed on the Privacy page; when it is absent (a profile
  saved before this change) the top bar shows PLAYER with the cursor.
- **First world:** the rotation always starts with the City of Tears.
- **Missing art:** without `library_hero.jpg` the banner uses `header.jpg`;
  without `logo.png` it shows the game's name in the pixel font.
- **Difficulty skulls** carry the number and label as accessible text.
- **The 404, Terms and Privacy pages** take the system as plain windows on black,
  without the animated scene.
- **Suggested order of work:** visual system and fonts with the CSP change;
  home page; game page; profile panel, search results and the document pages;
  Terms and Privacy text with the removals. Each is its own pull request.
