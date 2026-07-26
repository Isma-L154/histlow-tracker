# Setup

End to end this takes about twenty minutes, most of it in the Shortcuts app.

Nothing needs to be installed on the phone: Shortcuts ships with iOS.

---

## 1. Local environment

```bash
git clone https://github.com/Isma-L154/histlow-tracker.git
cd histlow-tracker
git checkout dev

python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
python -m pip install -e ".[dev]"

cp .env.example .env
```

Confirm the checkout is healthy before going further:

```bash
python -m pytest
python -m ruff check .
```

---

## 2. Credentials

Fill in `.env`. It is git-ignored and must never be committed.

### `STEAM_ID64`

Your 17-digit id, from [steamid.io](https://steamid.io).

The wishlist must be readable. Under
[Steam privacy settings](https://steamcommunity.com/my/edit/settings), set
**Game details** to **Public**.

Steam answers a private profile with HTTP 200 and an empty body rather than an
error, so the tracker raises `WishlistUnavailableError` instead of reporting
zero games. Silence would otherwise be indistinguishable from a working
tracker with nothing to report.

### `ITAD_API_KEY`

1. Sign in at [isthereanydeal.com](https://isthereanydeal.com).
2. Verify the account email. Unverified accounts get a lower rate limit.
3. Create an application at
   [isthereanydeal.com/apps/my](https://isthereanydeal.com/apps/my/).
4. Copy the value labelled **API key** into `.env`.

> Registering an app issues three credentials at once: an **API key**, an OAuth
> **Client ID** and an OAuth **Client Secret**. Only the API key works here.
> Supplying either OAuth value returns `403 Invalid or expired api key`, which
> reads like an expiry problem but is really the wrong credential.

### `GIST_TOKEN`

At [github.com/settings/tokens](https://github.com/settings/tokens), create a
token whose **only** scope is `gist`.

Do not reuse an existing broad-scope token. This is the single credential the
workflow could leak, and the `gist` scope is what bounds the damage to gists.

---

## 3. Create the gist

```bash
python scripts/bootstrap_gist.py
```

It prints two values and never prints the token:

- **`GIST_ID`** — add it to `.env`.
- **Raw URL** — needed in step 6. Treat it as a secret: a secret gist is
  unlisted, but its URL is unguessable rather than access-controlled.

---

## 4. First run

```bash
python -m histlow --dry-run --force
```

`--dry-run` prints the payload instead of publishing. `--force` bypasses the
schedule gate, which would otherwise decide it is not time yet.

Expect a summary like:

```
12 wishlisted -> 3 discounted -> 3 at all-time low -> 1 beat it -> 1 newly alerted
```

Zero at the last step is a perfectly normal result, and the usual one. Note
the two distinct stages: several games can sit *at* their all-time low while
none of them *beat* it, and by default only the latter is reported. See
`alerts.require_new_record` in `config.json`.

Once the output looks right, publish for real:

```bash
python -m histlow --force
```

Open the gist's raw URL in a browser to confirm the document is there.

---

## 5. Repository secrets

At **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
| --- | --- |
| `STEAM_ID64` | your 17-digit id |
| `ITAD_API_KEY` | the ITAD key |
| `GIST_ID` | from step 3 |
| `GIST_TOKEN` | the `gist`-scoped token |
| `STORE_COUNTRY` | optional, defaults to `CR` |
| `COMPARISON_COUNTRY` | optional, defaults to `US` |

Then run the workflow once by hand: **Actions → tracker → Run workflow**,
leaving **force** checked.

---

## 6. The iOS Shortcut

In the **Shortcuts** app, create a new shortcut named **HistLow**.

Add these actions in order:

| # | Action | Configuration |
| --- | --- | --- |
| 1 | **Get Contents of URL** | the raw gist URL from step 3, method `GET` |
| 2 | **Get Dictionary from Input** | — |
| 3 | **Set Variable** | name `payload`, value: *Dictionary* |
| 4 | **Get Dictionary Value** | get `Value` for key `count` in `payload` |
| 5 | **If** | *Dictionary Value* **is greater than** `0` |
| 6 | ↳ **Get Dictionary Value** | key `headline` in `payload` → **Set Variable** `title` |
| 7 | ↳ **Get Dictionary Value** | key `summary` in `payload` → **Set Variable** `body` |
| 8 | ↳ **Show Notification** | Title: `title`, Body: `body` |
| 9 | **End If** | — |

Step 2 is not optional. Gist raw URLs are served as `text/plain`, so
**Get Contents of URL** hands back a string rather than a parsed dictionary
and every **Get Dictionary Value** after it would fail.

Run it once with the play button. If the tracker found a new record, a
notification appears naming the games and their prices. If not, nothing
happens, which is the intended quiet path.

Raw gist responses carry `Cache-Control: max-age=300`, so a change can take up
to five minutes to become visible. That is far below the polling interval and
never matters in practice.

### Why the phone polls

iOS does not let an external server deliver a push notification without a
companion app installed. Rather than require one, the workflow writes to the
gist and the phone reads it on a schedule.

Because the phone composes the notification text locally, there is no paid
tier gating dynamic content: the alert names the game and its price.

The cost is latency. Alerts surface at the next poll rather than instantly.
Steam sales run for days, so this changes nothing in practice.

---

## 7. The automation

In **Shortcuts → Automation → New → Time of Day**:

- Time: pick one, for example `09:00`
- Repeat: **Daily**
- Choose **HistLow**
- Set it to **Run Immediately** and turn **Notify When Run** off

Repeat for two or three more times a day. Each automation holds a single time,
so several are needed for several checks.

Suggested: `09:00`, `14:00`, `20:00`.

More often adds nothing. The workflow itself only refreshes the payload once a
day outside sale windows.

---

## Operating notes

### Cadence

Fully controlled by `config.json`; the workflow YAML never changes.

- Outside a sale window: once a day, anchored to `daily_run_hours_utc`.
- Inside a window listed in `sale_windows`: every `interval_hours`.

Sale dates are estimates. Update them when Valve announces the real ones.

### Cost

Roughly three HTTP requests and a few seconds of runtime per run, well inside
the free tier for a private repository.

### Scheduled workflows get disabled

GitHub disables cron workflows in repositories with no activity for 60 days,
after sending a warning email. A single commit resets the clock.

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| `WishlistUnavailableError` | Game details is not set to Public |
| `none of the N candidate games could be compared` | `COMPARISON_COUNTRY` names a region ITAD does not track; set it to `US` |
| `ITAD rejected the API key` | wrong `ITAD_API_KEY`, or the email is unverified |
| `The gist was not found` | wrong `GIST_ID`, or the token belongs to another account |
| `GitHub rejected the gist token` | the token lacks the `gist` scope |
| Notification never arrives | run the Shortcut manually; if that works, the automation is the problem |
| Same game alerts repeatedly | expected only when the price drops further; otherwise check that the state cache is being restored |

Add `--log-level DEBUG` for per-app detail. Secrets are masked at every level.
