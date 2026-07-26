# Steam HistLow Tracker

Watches a public Steam wishlist and raises an alert only when a game is
discounted **to or below its all-time low price on Steam**.

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
        |  4. State   - suppress anything already alerted
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

```
.github/workflows/     CI and the scheduled tracker run
src/histlow/
  domain.py            Frozen dataclasses. No I/O.
  config.py            Environment + config.json loading and validation
  net.py               HTTP client: timeouts, retries, backoff, redaction
  steam.py             Wishlist and batched store prices
  itad.py              App-id resolution cache and per-store historical lows
  state.py             Alert de-duplication across runs
  selector.py          Pure decision logic: which deals qualify
  publisher.py         Payload rendering and gist upload
  scheduling.py        Sale-window gate
  pipeline.py          Orchestration
tests/                 Unit tests; no network access required
docs/                  iOS Shortcut setup, operations runbook
config.json            Non-secret runtime configuration
.env.example           Template for local runs
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

## Setup

Step-by-step instructions live in [`docs/SETUP.md`](docs/SETUP.md).

## License

MIT
