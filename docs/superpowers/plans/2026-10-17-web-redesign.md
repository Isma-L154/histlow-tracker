# HowToAchieve Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, in the main session (this repository forbids subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the redesign in the spec: the animated pixel-art home page, the game page with loot tiers and profile progress, the restyled profile panel and documents, and the content and security changes that come with them.

**Architecture:** Everything stays in `web/public/` as plain ES modules with no build step. Pure logic (tiers, sprite data, scaling, the animation loop) lives in small modules with `.d.ts` files so vitest can import them, following `difficulty.js`. `app.js` keeps the DOM wiring; `styles.css` holds the visual system. The Worker only loses the upcoming route.

**Tech Stack:** Plain JavaScript, HTML and CSS in the browser; TypeScript Worker on Cloudflare; vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-10-17-web-redesign-design.md`

**Reference mockups (local, ignored by git):** `.superpowers/brainstorm/1380-1792268775/content/` — `home-icons.html` holds the approved sprites, palettes and scene drawing code to port; `game-page.html` the game page; `home-profile.html` the profile panel. Port from them; do not copy their inline styles or scripts as-is, since the CSP forbids inline code.

## Global Constraints

- No runtime dependencies, no build step in `web/`; every new browser module is a plain `.js` file under `web/public/` loaded as an ES module.
- Code, comments, commits, PRs and issues in English; every new interface string in `web/public/i18n.js` in both `en` and `es`.
- Never add a named export to `web/src/index.ts`.
- Keep the global `[hidden]` guard in `styles.css`.
- Palette: page `#000000`; window border `4px solid #F2ECE2`, outer ring `0 0 0 4px #000`, radius `6px`; text `#FFFFFF` / `#F2ECE2`; muted `#BDBDBD`; cursor and headings white.
- Tier colours: legendary `#F2B33D`, epic `#B06EF0`, rare `#4FA3F7`, uncommon `#5FD06A`, common `#A8A8A8`; "No data" uses the muted grey.
- Tier thresholds: legendary `< 5`, epic `5 ≤ p < 10`, rare `10 ≤ p < 25`, uncommon `25 ≤ p < 50`, common `≥ 50`, unknown when the percentage is `null`.
- Fonts: Press Start 2P (labels, numbers, titles) and Pixelify Sans (reading text, `font-variant-ligatures: none`), self-hosted WOFF2, `font-display: swap`.
- Home: five heroes in this order — sun knight, black mage, green-capped swordsman, pale warrior, cowboy; five worlds in this order — City of Tears, The Lands Between, Hell, Olympus, The Frontier; rotate every 9 s with a stepped fade; first world always City of Tears; lightning on Olympus every 5 s; no world name shown, only dots.
- Each tier shows its first 5 achievements, then a `▼ N MORE` button.
- Storage keys: existing `histlow.steamid`; new `histlow.profileName`.
- Each phase is one issue, one branch, one PR closing it; browser check before merge; `semgrep` on changed code.
- Every task runs on Opus 5, in the main session, with no subagents (the owner's decision for this plan).

## Review Focus

1. **A game with hundreds of achievements** (some have 500+) should render quickly and keep rarest-first order inside each tier — pinned in Task 6 (`groupByTier` with 1000 items).
2. **A game Steam has no `library_hero.jpg` or `logo.png` for** should still get a banner and a title, not broken images — pinned in Task 7 (`bannerSources`).
3. **A 320–375 px phone** should get a crisp hero with no horizontal scroll and every hero visible — pinned in Task 4 (`pickScale`).
4. **Reduced motion or a hidden hero** should cost no animation frames — pinned in Task 4 (`createLoop` with an injected scheduler).
5. **An achievement with no percentage, no description or an empty `iconLocked`** should land in "No data", say it is hidden, and show a greyed icon — pinned in Tasks 6 and 8.

---

## Phase 1 — Visual system (one PR)

### Task 1: Self-hosted fonts and the CSP that allows them — [Opus 5]

**Files:**
- Create: `web/public/fonts/press-start-2p.woff2`, `web/public/fonts/pixelify-sans.woff2`, `web/public/fonts/OFL-PressStart2P.txt`, `web/public/fonts/OFL-PixelifySans.txt`
- Modify: `web/public/_headers` (CSP line), `web/public/styles.css` (top: `@font-face`)
- Test: `web/test/csp.test.ts`

**Interfaces:**
- Produces: font families `"Press Start 2P"` and `"Pixelify Sans"` for every later task.

- [ ] **Step 1: Write the failing test** `web/test/csp.test.ts`: read `../public/_headers?raw`, extract the `Content-Security-Policy` value, and assert `it("lets the site load its own fonts")` → directives include `font-src 'self'`; `it("still forbids everything by default")` → `default-src 'none'`.
- [ ] **Step 2: Run** `npm test -- csp` from `web/`. Expected: FAIL on `font-src`.
- [ ] **Step 3:** Add `font-src 'self'` to the CSP in `_headers`. Download the Latin subset WOFF2 of each family from the Google Fonts CSS2 API (Pixelify Sans as the variable `wght 400..700` file) and each family's `OFL.txt` from `github.com/google/fonts` (`ofl/pressstart2p`, `ofl/pixelifysans`). Declare both with `@font-face` (`font-display: swap`, `src: url("/fonts/…") format("woff2")`).
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): self-host the pixel fonts and allow them in the CSP`.

### Task 2: The visual system and the shared chrome — [Opus 5]

**Files:**
- Modify: `web/public/styles.css` (tokens, top bar, search, results, buttons, language, footer, status, narrow, motion), `web/public/index.html` (brand markup only), `web/public/404.html`, `web/public/privacy.html`, `web/public/terms.html` (brand markup only)
- Test: existing `web/test/styles.test.ts`, `web/test/shell.test.ts`

**Interfaces:**
- Produces, in `styles.css`: custom properties `--page`, `--edge`, `--text`, `--muted`, `--tier-legendary`, `--tier-epic`, `--tier-rare`, `--tier-uncommon`, `--tier-common`; classes `.window` (the bordered window), `.cursor` (CSS triangle; `.cursor.is-active` animates), `.cells` with child `i` / `i.is-on` (segmented bar, `--cells` sets the count), `.pixel-label` (Press Start 2P, small caps size).

- [ ] **Step 1:** Replace the colour tokens with the spec palette and add the tier and component classes above. The brand becomes the wordmark `HOWTOACHIEVE` in Press Start 2P (keep `<a class="brand" href="/">`, which `shell.test.ts` and `app.js` rely on). Top bar, search input, results dropdown, EN/ES toggle and footer adopt windows and pixel labels. Keep the sticky bars on the page colour (`styles.test.ts`).
- [ ] **Step 2: Run** `npm test`. Expected: all pass (`styles.test.ts` catches undefined custom properties and a beaten `[hidden]`).
- [ ] **Step 3: Browser check** with `npm run dev`: home and a game page in both languages, results dropdown, 404; no element still on the old blue accent; no horizontal scroll at 375 px.
- [ ] **Step 4: Commit** `feat(web): adopt the pixel visual system across the shared chrome`.

## Phase 2 — Home page (one PR)

### Task 3: Hero sprites as data — [Opus 5]

**Files:**
- Create: `web/public/world/sprites.js`, `web/public/world/sprites.d.ts`
- Test: `web/test/sprites.test.ts`

**Interfaces:**
- Produces:
  - `export const HEROES: readonly Hero[]` in the spec's order, where `Hero = { id: "sunKnight" | "blackMage" | "swordsman" | "warrior" | "cowboy"; palette: Record<string, string>; body: string[]; legs: { a: string[]; b: string[] } }`
  - `export function drawSprite(ctx: CanvasRenderingContext2D, rows: readonly string[], palette: Record<string, string>, x: number, y: number): void` — `.` is transparent.
  - `export function heroRows(hero: Hero, frame: 0 | 1): string[]` — body followed by that frame's legs.

- [ ] **Step 1: Write the failing tests:** `it("lists the five heroes in the spec's order")` → ids equal `["sunKnight","blackMage","swordsman","warrior","cowboy"]`; `it("draws every row 16 pixels wide")`; `it("defines every colour a sprite uses")` → each non-`.` character in body and legs is a key of the palette; `it("gives both walking frames the same height")`.
- [ ] **Step 2: Run** `npm test -- sprites`. Expected: FAIL, module missing.
- [ ] **Step 3:** Port the five heroes from `home-icons.html` (`heroes` array and `LEGS`).
- [ ] **Step 4: Run** `npm test -- sprites`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add the home page heroes as sprite data`.

### Task 4: Worlds, scaling and the animation loop — [Opus 5]

**Files:**
- Create: `web/public/world/scenes.js`, `web/public/world/engine.js`, `web/public/world/engine.d.ts`
- Test: `web/test/engine.test.ts`

**Interfaces:**
- Consumes: `HEROES`, `heroRows`, `drawSprite` from Task 3.
- Produces:
  - `scenes.js`: `export const WORLDS: readonly { id: "cityOfTears" | "landsBetween" | "hell" | "olympus" | "frontier"; build(width: number, height: number): (ctx: CanvasRenderingContext2D, seconds: number) => void }[]` in the spec's order; each `build` pre-renders its layers at that size.
  - `engine.js`: `export function pickScale(containerWidth: number): { scale: number; width: number }` (internal height is always 150); `export function createLoop(options: { draw: (seconds: number) => void; schedule: (callback: (ms: number) => void) => unknown; reducedMotion: boolean }): { start(): void; stop(): void }`; `export function mountWorld(canvas: HTMLCanvasElement, dots: HTMLElement): void` — sizes the canvas, rotates worlds every 9 s with the stepped fade, walks the heroes, observes visibility and resize.

- [ ] **Step 1: Write the failing tests:** `pickScale(375)` → `{ scale: 2, width: 188 }`; `pickScale(320)` → `{ scale: 2, width: 160 }`; `pickScale(1200)` → `{ scale: 4, width: 300 }`; `pickScale(3000)` → scale `4`; for every width from 320 to 2560, `width * scale >= containerWidth`, `width >= 160` and `scale` is a whole number from 2 to 4. `createLoop` with `reducedMotion: true` calls `draw` exactly once and never calls `schedule`; with `false`, `start()` schedules a frame and `stop()` stops further `draw` calls.
- [ ] **Step 2: Run** `npm test -- engine`. Expected: FAIL.
- [ ] **Step 3:** Implement `pickScale` as `scale = clamp(Math.floor(containerWidth / 300), 2, 4)`, `width = Math.ceil(containerWidth / scale)`; hero x positions are fractions of `width` so all five fit from 160 up. Implement `createLoop` over the injected `schedule`. Port the five worlds from `home-icons.html`, parameterised by width (positions as fractions of width, layers tile horizontally). `mountWorld` uses `requestAnimationFrame`, an `IntersectionObserver` that stops the loop off screen, `matchMedia("(prefers-reduced-motion: reduce)")`, and starts on City of Tears.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): animate the five worlds and the walking party`.

### Task 5: The new home page, without upcoming releases — [Opus 5]

**Files:**
- Modify: `web/public/index.html` (`#hero` section), `web/public/app.js` (home routing, examples, remove `loadUpcoming`, `renderUpcoming`, `countdown` and their calls), `web/public/styles.css` (hero; delete the upcoming section), `web/public/i18n.js` (hero keys; delete `upcoming.*`)
- Test: existing `i18n.test.ts`, `language-markup.test.ts`, `shell.test.ts`, `entrypoint.test.ts`

**Interfaces:**
- Consumes: `mountWorld` from Task 4.
- Produces: `#hero` contains `<canvas class="world" aria-hidden="true">`, `.world-dots`, `h1.logo`, `p.tagline` (`data-i18n="hero.tagline"`), `#hero-search-slot`, and the four example buttons (unchanged `data-appid`).

- [ ] **Step 1:** Rewrite the hero markup above. New key `hero.tagline`: en "Every Steam achievement, from the rarest to the most common, and how to earn it." / es "Todos los logros de Steam, del más raro al más común, y cómo conseguirlos." Remove keys no longer used (`hero.title`, `hero.lead`, `upcoming.*`) and the upcoming markup.
- [ ] **Step 2:** In `app.js`, call `mountWorld` once on load; in `route()`, move `el.form` into `#hero-search-slot` on the home page and back into the top bar on a game page (moving the node keeps its listeners). Delete the upcoming functions and the `renderUpcoming()` call in `setLanguage`.
- [ ] **Step 3: Run** `npm test`. Expected: all pass (i18n parity, markup keys, brand link, no named export).
- [ ] **Step 4: Browser check:** every world in turn; search from the hero reaches a game and the box returns to the top bar; back button returns it to the hero; reduced-motion still frame; 375 px; both languages; no request to `/api/upcoming` in the network panel.
- [ ] **Step 5: Commit** `feat(web): turn the home page into the pixel world`.

## Phase 3 — Game page (one PR)

### Task 6: Loot tiers — [Opus 5]

**Files:**
- Create: `web/public/tiers.js`, `web/public/tiers.d.ts`
- Modify: `web/public/app.js` (replace `rarityTier`), `web/public/i18n.js` (`rarity.*` keys)
- Test: `web/test/tiers.test.ts`

**Interfaces:**
- Produces: `export type Tier = "legendary" | "epic" | "rare" | "uncommon" | "common" | "unknown"`; `export function lootTier(percent: number | null): Tier`; `export function groupByTier<T extends { globalPercent: number | null }>(items: readonly T[]): { tier: Tier; items: T[] }[]` — tiers in the order above, empty tiers omitted, input order kept inside each; `export function heldCells(percent: number | null): number` — filled cells out of 20, `Math.round(percent / 5)` clamped to 1..20, `0` for `null`.

- [ ] **Step 1: Write the failing tests:** boundaries `0→legendary`, `4.99→legendary`, `5→epic`, `9.99→epic`, `10→rare`, `24.99→rare`, `25→uncommon`, `49.99→uncommon`, `50→common`, `100→common`, `null→unknown`; `groupByTier` over 1000 generated items keeps every item exactly once, in input order within a tier, with tiers in the fixed order and no empty tier; `heldCells(0.1)→1`, `heldCells(76.7)→15`, `heldCells(100)→20`, `heldCells(null)→0`.
- [ ] **Step 2: Run** `npm test -- tiers`. Expected: FAIL.
- [ ] **Step 3:** Implement. Replace `rarityTier` in `app.js` with `lootTier`; keys `rarity.legendary|epic|rare|uncommon|common|unknown` with ranges — en "Legendary", "Epic", "Rare", "Uncommon", "Common", "No data"; es "Legendario", "Épico", "Raro", "Poco común", "Común", "Sin datos" — and `rarity.range.*` for the header ranges ("held by under 5%" / "en manos de menos del 5%", "5 to 10%", "10 to 25%", "25 to 50%", "over 50%").
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): group achievements into loot tiers`.

### Task 7: Banner, game panel and progress — [Opus 5]

**Files:**
- Create: `web/public/art.js`, `web/public/art.d.ts`
- Modify: `web/public/index.html` (`#game` head), `web/public/app.js` (`renderGame`, `renderProgress`, `renderDifficulty`, `renderLinks`), `web/public/styles.css`, `web/public/i18n.js`
- Test: `web/test/game-art.test.ts`

**Interfaces:**
- Produces: `export function bannerSources(appId: number, headerImage: string | null): { hero: string[]; logo: string }` — `hero` is `[library_hero.jpg URL, headerImage]` without nulls; `logo` is the `logo.png` URL; both on `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appId}/`. `export function rarestHeld<T extends { unlocked: boolean | null; globalPercent: number | null; name: string }>(achievements: readonly T[]): T | null`.

- [ ] **Step 1: Write the failing tests:** `bannerSources(367520, "h.jpg").hero` equals the library hero URL then `"h.jpg"`; with `headerImage` `null` it has one entry; `rarestHeld` returns the unlocked achievement with the lowest non-null percentage, `null` when none is unlocked or `unlocked` is `null` everywhere.
- [ ] **Step 2: Run** `npm test -- game-art`. Expected: FAIL.
- [ ] **Step 3:** Implement. Banner: `<img>` tries each `hero` source in turn on `error`; logo `<img>` on error is replaced by the game name in Press Start 2P. Game panel: count, ten skull pips as inline SVG with the score and tier label as visually hidden text, time to 100 %, guides and store links with the cursor. Progress panel when `unlockedCount !== null`: "U / T", percent, an XP `.cells` bar of `min(total, 100)` cells with `Math.round(unlocked / total * cells)` filled, and "Rarest you hold"; otherwise the invitation text. New keys: `game.panel`, `progress.title`, `progress.rarest`, `progress.invite.title`, `progress.invite.body`, in both languages.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): add the game banner, panel and progress`.

### Task 8: Tiered list, item slots and the how-to dialogue — [Opus 5]

**Files:**
- Modify: `web/public/app.js` (`renderGame` list, `renderAchievement`, `rarityMeter`, filters, `renderHowTo` container), `web/public/styles.css`, `web/public/i18n.js`
- Test: `web/test/tiers.test.ts` (extend)

**Interfaces:**
- Consumes: `groupByTier`, `lootTier`, `heldCells` (Task 6); `drawSprite`, `HEROES` (Task 3).
- Produces: `export const VISIBLE_PER_TIER = 5` and `export function lockedIcon(a: { icon: string; iconLocked: string }): { src: string; greyed: boolean }`, both in `tiers.js`.

- [ ] **Step 1: Write the failing tests:** `lockedIcon({ icon: "a", iconLocked: "b" })` → `{ src: "b", greyed: false }`; `lockedIcon({ icon: "a", iconLocked: "" })` → `{ src: "a", greyed: true }`; `VISIBLE_PER_TIER` → `5`.
- [ ] **Step 2: Run** `npm test -- tiers`. Expected: FAIL.
- [ ] **Step 3:** Implement the helpers, then render: one `<section class="tier" data-tier>` per group (gem, name, range, count); rows with the coloured slot, name, description or the existing `achievement.hidden` text, UNLOCKED + date / NOT YET when a profile is known, and a 20-cell "held by" bar using `heldCells`; after the fifth row a `<button class="tier-more">▼ N MORE</button>` that reveals the rest. The filters become tabs (ALL always; MISSING and UNLOCKED only when `unlockedCount !== null`) with their counts in Press Start 2P; they hide rows and any tier left empty, and recount. The how-to panel renders inside a `.window.dialog` with a 16×16 canvas portrait of the black mage's head (`HEROES[1]`, first 16 rows) beside the existing steps, sources, disclaimer and "not explained" states. New keys `tier.more`, `achievement.state.unlocked`, `achievement.state.locked`, `howto.narrator`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Browser check:** Hollow Knight with and without a profile; a game with hidden achievements; a game with 100+ achievements; MISSING and UNLOCKED hide empty tiers; how-to answered, not answered and throttled; both languages; 375 px (state and bar wrap under the name).
- [ ] **Step 6: Commit** `feat(web): show achievements as loot tiers with an RPG how-to dialogue`.

## Phase 4 — Profile panel and documents (one PR)

### Task 9: The PLAYER window, its stored name, and the document pages — [Opus 5]

**Files:**
- Modify: `web/public/index.html` (profile markup), `web/public/app.js` (save, clear, top bar label), `web/public/styles.css` (profile, documents), `web/public/i18n.js`, `web/public/privacy.html`, `web/public/terms.html`, `web/public/404.html`

- [ ] **Step 1:** Restyle the panel as in `home-profile.html`: PLAYER heading, field in a window, SAVE and REMOVE as cursor menu items, status as a dialogue line, help disclosure. Keep the outside-click and Escape handlers in `app.js` unchanged.
- [ ] **Step 2:** On a successful save, store `resolved.profileName` under `histlow.profileName` (through the existing `store()`); remove it on REMOVE; the summary shows the stored name, or `PLAYER` with the cursor when only the id is stored, or `PROFILE` with none.
- [ ] **Step 3:** Privacy: add `histlow.profileName` to "What is stored in your browser". Documents and 404 render as windows on black with the pixel headings.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Browser check:** save a real profile, reload (name shown), remove (PROFILE shown), outside click and Escape close the panel, Privacy and Terms readable at 375 px.
- [ ] **Step 6: Commit** `feat(web): restyle the profile panel and remember the profile name`.

## Phase 5 — Content and removals (one PR)

### Task 10: Remove the upcoming route, tighten the CSP, update Terms and Privacy — [Opus 5]

**Files:**
- Modify: `web/src/index.ts` (route and `features`), `web/src/igdb.ts` (`upcoming` and helpers only it uses), `web/test/igdb.test.ts`, `web/test/configuration.test.ts`, `web/public/_headers`, `web/test/csp.test.ts`, `web/public/privacy.html`, `web/public/terms.html`
- Delete: `web/test/configuration-upcoming.test.ts`

- [ ] **Step 1: Write the failing tests:** in `csp.test.ts`, `it("no longer lets the browser load IGDB images")` → `img-src` excludes `images.igdb.com`; in `configuration.test.ts`, `/api/health` `features` equals `{ completionTime: … }` with no `upcoming` key, and `/api/upcoming` answers 404.
- [ ] **Step 2: Run** `npm test`. Expected: those FAIL.
- [ ] **Step 3:** Remove the route, `features.upcoming`, `IgdbClient.upcoming`, `UpcomingLookup`, `UpcomingRelease`, and each of `exactDateFormat`, `majorPlatforms`, `reachesConsole`, `positive`, `identifier` that `graphify_callers` (then `grep`) shows no remaining caller for; their tests; `images.igdb.com` from `img-src`. Terms: a new "Fan art on the home page" section after "No affiliation", saying the characters and worlds are original pixel-art tributes inspired by games, not official material, not affiliated with or endorsed by their rights holders (FromSoftware, Bandai Namco, Square Enix, Nintendo, Sony Interactive Entertainment, Rockstar Games, Team Cherry, Bethesda), whose characters and trademarks remain theirs, and that any of them who asks will have them removed promptly via info@cloudils.com; bump "Last updated". Privacy: drop IGDB from "Who else sees you"; bump its date.
- [ ] **Step 4: Run** `npm test`, then `npx wrangler types && npx tsc --noEmit`. Expected: all pass, no type errors.
- [ ] **Step 5:** Run the `docs-sync` skill (README mentions of upcoming releases, the architecture diagram) and `security-scan` (exposed surface changed).
- [ ] **Step 6: Commit** `feat(web): drop upcoming releases, tighten the CSP and publish the fan-art notice`.

## Phase 6 — Clean-up pass (one PR)

### Task 11: Run `clean-project` over the redesigned module — [Opus 5]

**Files:** whatever the pass finds; expected in `web/`.

- [ ] **Step 1:** Run the `clean-project` skill inline (no subagents) over the repository, focused on `web/`: dead code left by the redesign (old hero, chip and upcoming styles, unused i18n keys, unused helpers), duplication between `app.js` and the new modules, SOLID and comment rot.
- [ ] **Step 2:** Triage each finding with the owner's rules: fix what is real, note what is deliberate. Each fix keeps `npm test`, `npx tsc --noEmit` and `python -m pytest` green.
- [ ] **Step 3: Browser check** of home, a game page with and without a profile, the profile panel and the documents, in both languages.
- [ ] **Step 4: Commit** `refactor(web): clean up after the redesign`.
