# Steam HistLow Tracker

Watches a public Steam wishlist and raises an alert only when a game's sale
**beats its all-time low price on Steam** — a new record, not a return to an
old one.

Runs as a GitHub Actions cron job. Zero runtime dependencies, zero servers,
zero cost. Notifications land on iOS through the pre-installed Shortcuts app,
so there is no third-party notification app to install.

---

## How it works

```
GitHub Actions (cron)
        |
        |  1. Steam  - IWishlistService/GetWishlist    -> app ids
        |  2. Steam  - appdetails (batched, 30/req)    -> current prices
        |             ^ filter: keep only discounted titles
        |  3. ITAD    - games/storelow/v2 (shops=[61]) -> all-time Steam low
        |             ^ filter: current <= historical low
        |  4. ITAD    - games/history/v2 -> did this sale set that low?
        |             ^ filter: keep only new records
        |  5. State   - suppress anything already alerted
        |
        v
  Secret GitHub Gist  (payload.json)
        ^
        |  polled on a schedule
        |
  iOS Shortcuts automation  ->  local notification with title and price
```

Three HTTP requests per run for a 20-game wishlist.

### Why the historical low is queried per-store

IsThereAnyDeal's generic `games/historylow/v1` returns the lowest price across
*every* shop it tracks. Key resellers routinely undercut Steam, so a Steam
price would essentially never match that figure and the tracker would never
fire. `games/storelow/v2` scoped to `shops=[61]` (Steam) is the correct
comparison and the reason this project works at all.

### Why a new record, not just the all-time low

Being *at* the all-time low and *setting* it are different events, and the
stores label them differently. Steam tends to repeat a title's deepest
discount, so a game can sit at its record price in sale after sale without ever
going lower.

`alerts.require_new_record` keeps only the sales that actually went lower.
This makes alerts considerably rarer by design. Set it to `false` to be told
whenever a game is merely at its low again.

Deciding this needs `games/history/v2`, because the current price cannot answer
it: ITAD records a new low the instant Steam drops the price, so by the time
the tracker reads it, current and low are always equal. The test used instead
is exact — the sale set the record precisely when the newest history entry
carries the recorded low's timestamp, and ITAD stamps both identically.

A game whose history cannot be loaded is dropped rather than assumed to be a
record, and the run logs that distinctly so a lookup failure is not mistaken
for a quiet day.

### Why two regions

ITAD does not carry price history in every currency Steam sells in. It reports
the Costa Rican and Mexican storefronts in USD, not in colones or pesos, and
comparing a colón price against a dollar low is meaningless.

So the tracker splits the two jobs:

- `STORE_COUNTRY` is where you buy. It sets the prices in the notification, in
  the currency you actually pay.
- `COMPARISON_COUNTRY` is a region ITAD does track. The at-or-below decision
  happens there.

Steam applies the same discount percentage worldwide, so a title at its
all-time USD low is at its all-time local low too. When ITAD already tracks
your currency, set the two to the same value and the extra request disappears.

If every candidate fails the currency check the run raises rather than
returning nothing, because "no deals" and "the comparison is broken" would
otherwise look identical.

### Why the phone polls instead of receiving a push

iOS does not allow an external server to deliver a push notification without a
companion app installed. Rather than require one, the workflow writes a small
JSON payload to a secret gist and a Shortcuts automation reads it on a
schedule. Shortcuts ships with iOS, builds the notification text locally, and
therefore has no paid tier gating dynamic content.

The tradeoff is latency: alerts surface at the next poll rather than instantly.
Steam sales run for days, so this costs nothing in practice.

---

## Repository layout

Runs once a day at 18:17 Costa Rica time, year round, with no seasonal
calendar to maintain.

```
.github/workflows/     CI, the scheduled tracker run, and the cron keepalive
src/histlow/
  domain.py            Frozen dataclasses. No I/O.
  config.py            Environment + config.json loading and validation
  net.py               HTTP client: timeouts, retries, backoff, redaction
  steam.py             Wishlist and batched store prices
  itad.py              App-id resolution cache and per-store historical lows
  state.py             Alert de-duplication across runs
  selector.py          Pure decision logic: which deals qualify
  publisher.py         Payload rendering and gist upload
  scheduling.py        Guard against running the same work twice
  pipeline.py          Orchestration
tests/                 Unit tests; no network access required
docs/                  iOS Shortcut setup, operations runbook
config.json            Non-secret runtime configuration
.env.example           Template for local runs
web/                   Cazalogros - the achievement browser (see below)
  src/                 Cloudflare Worker: Steam client, guide corpus, how-to
  public/              The page itself: no framework, no build step
```

Layering is one-directional: `domain` depends on nothing, adapters depend on
`domain`, `selector` is pure, and only `pipeline` wires them together.

---

## Money handling

All prices are integer **minor units** (cents). Floating-point currency is
never constructed, compared, or serialised: `1499 <= 1499` is exact where
`14.99 <= 14.99` is not guaranteed to be.

---

## Security posture

- Secrets are read from the environment only, never from tracked files.
  `.env` is git-ignored; `.env.example` carries empty placeholders.
- The gist token is scoped to `gist` alone. It is the only credential the
  workflow can leak, and its blast radius is one gist by construction.
- All log output passes through a redaction filter that masks any configured
  secret value before it reaches stdout.
- The workflow requests `permissions: contents: read` and does not run on
  `pull_request`, so forks can never observe the secrets.
- The published payload contains public store data only: app ids, titles and
  prices. No account identifiers, no personal data.

---

## Local usage

```bash
cp .env.example .env      # then fill in the values
python -m pip install -e ".[dev]"
python -m histlow --dry-run
```

`--dry-run` executes the full pipeline and prints what would be published
without writing to the gist or mutating state.

---

# Cazalogros

A second, independent module in this repository: a web page that lists every
achievement in a Steam game, ordered by how rare it actually is, and explains
**how each one is earned** — in Spanish, on the page, rather than linking out.

Lives in [`web/`](web/) and shares nothing with the tracker but the repo.

## How it works

```
Browser
   |
   |  /            -> served straight from web/public by Cloudflare's asset
   |                  runtime. Worker code does not execute at all.
   |  /api/*       -> the Worker
   v
Cloudflare Worker
   |
   |  1. Steam  SearchApps / appdetails            -> find the game
   |  2. Steam  GetSchemaForGame                   -> names, descriptions, icons
   |  3. Steam  GetGlobalAchievementPercentages    -> how rare each one is
   |  4. Steam  GetPlayerAchievements (optional)   -> which ones you hold
   |  5. Steam  guide hub + guide pages            -> the guide corpus
   |  6. Workers AI                                -> the passages, as steps
   v
One JSON response per achievement, cached at the edge.
```

### Where the steps come from

Steam's API does not expose guide bodies. `GetDetails` returns only the
author's summary, `num_children` is 0 and `file_url` is the cover image, so
the text is read from the rendered guide page with `HTMLRewriter` — which
parses in the runtime rather than in JavaScript, and therefore fits the free
plan's 10 ms of CPU per request. Six guides were measured to fit.

Passages are matched to an achievement by its **name**, which survives
translation: Steam keeps achievement names in English inside a Russian guide,
and that is the only reason a foreign-language corpus is searchable. When a
game's top-rated guides are route walkthroughs that never name an achievement,
a second search aimed at that name runs instead. On Hollow Knight that took
coverage from 3 of 12 to 10 of 12.

The model only ever sees retrieved passages and is instructed to report that
it cannot answer rather than fill the gap. **Coverage is deliberately not
100%.** Some achievements have no written guide, and some — "finish the game
in under 10 hours" — have no steps to give. Saying so beats inventing them.

### Cost

Nothing, and it cannot become something. The Cloudflare **Free** plan has no
billable overflow: when the daily allocation of 10,000 Neurons is spent,
inference stops serving and the page falls back to showing the raw guide
passages. Reaching a bill would require manually upgrading the account.

| Resource | Free allowance | Typical use |
|---|---|---|
| Worker requests | 100,000/day | dozens |
| Workers AI | 10,000 Neurons/day | ~139 per new answer, so ~70/day |
| Steam Web API | no charge | — |

Answers cache for a week, misses for an hour, and the guide corpus for a week
per game — so a game you have already opened costs nothing at all.

## Does it work on a phone?

Yes. It is a normal responsive website, so any mobile browser opens it — no
app, no install, nothing to add to a home screen. Verified at 320 px, 390 px
and 768 px on an emulated touch device.

The adaptation is plain CSS, in [`web/public/styles.css`](web/public/styles.css):

- **Fluid by default.** The layout is flexbox with `max-width` caps and
  `clamp()` type, so it reflows continuously instead of snapping between fixed
  designs. Most of the page needs no breakpoint at all.
- **`≤ 40rem`** — the top bar wraps, the wordmark's tagline and the profile
  button's label drop to their icons, and the profile panel anchors to the bar
  rather than to its own button. Without that last rule the panel hangs off
  the left edge at 320 px, because the button it was anchored to has shrunk to
  an icon at the far right.
- **`≤ 34rem`** — each achievement drops from three columns to two: the rarity
  figure moves below the description instead of being squeezed beside it, and
  the icon shrinks from 64 px to 48 px.
- **Touch targets** stay at or above 30 px tall throughout, and the page never
  scrolls horizontally at any tested width.

Dark only, on purpose: it is a companion to Steam, which is dark.

## Deploying it

```bash
cd web
npm install
npx wrangler secret put STEAM_WEB_API_KEY   # prompts; never a CLI argument
npm run check                               # typecheck + build dry run
npm run deploy
```

`web/wrangler.jsonc` holds the non-secret configuration: cache lifetimes, how
many guides form the corpus, and which model writes the steps.

## Security posture

- **No credential reaches the browser.** The Steam key exists only as a Worker
  secret and only ever appears in a query to `api.steampowered.com`. Error
  messages return a status code and a fixed label, never the URL that failed,
  and logged errors are redacted before they reach the observability panel.
- **Nothing from an API is inserted as HTML.** Achievement text is written by
  game developers and guide text by strangers; both reach the page only
  through `textContent`. There is no `innerHTML` in the client.
- **A strict CSP** in [`web/public/_headers`](web/public/_headers) starts from
  `default-src 'none'` and allows only same-origin scripts and styles plus
  Steam's image CDNs, so anything injected has nowhere to send what it finds.
- **No user input reaches an upstream URL unencoded.** App ids are matched as
  digits by the route pattern, guide ids as digits from the fetched HTML, and
  achievement names pass through `encodeURIComponent`.
- **The edge cache is the rate limit.** Cache keys are built from the canonical
  route rather than the incoming URL, so appending a junk parameter cannot miss
  the cache on every request and burn the Steam key's quota.

Semgrep (`p/typescript`, `p/javascript`, `p/xss`, `p/secrets`,
`p/command-injection`, and Trail of Bits' rules) reports no findings.

---

## Setup

Step-by-step instructions live in [`docs/SETUP.md`](docs/SETUP.md).

## License

MIT
