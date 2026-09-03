# Steam HistLow Tracker

*Two Steam side projects in one repository: a wishlist watcher that alerts only
when a game beats its all-time low price, and [HowToAchieve](#howtoachieve), a
browser for a game's achievements ranked by how rare they really are.*

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
---

## Repository layout

Runs once a day at 18:17 Costa Rica time, year round, with no seasonal
calendar to maintain.

```
.github/workflows/     CI, the scheduled tracker run, the cron keepalive,
                       and the deploy that publishes web/ on every push to main
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
web/                   HowToAchieve - the achievement browser (see below)
  src/                 Cloudflare Worker: Steam client, guide corpus, how-to
  public/              The page itself: no framework, no build step
```

Layering is one-directional: `domain` depends on nothing, adapters depend on
`domain`, `selector` is pure, and only `pipeline` wires them together.

# HowToAchieve

A second, independent module in this repository: a web page that lists every
achievement in a Steam game, ordered by how rare it actually is, and explains
**how each one is earned** — on the page, rather than linking out.

Live at **[howtoachieve.cloudils.com](https://howtoachieve.cloudils.com)**.

Lives in [`web/`](web/) and shares nothing with the tracker but the repo.

### Credentials

Set with `wrangler secret put NAME` from `web/`, never committed:

| Secret | Needed for |
|---|---|
| `STEAM_WEB_API_KEY` | Everything. The Worker refuses to build a Steam client without it. |
| `TWITCH_CLIENT_ID` | Optional. IGDB, for completion times. |
| `TWITCH_CLIENT_SECRET` | Optional, the other half of the pair. |

IGDB authenticates through Twitch: register an application at
[dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) with
`http://localhost` as the redirect URL. It is free. Without the pair, the
completion time is simply absent and the rest of the site is unaffected.

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


