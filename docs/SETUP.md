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
| 4 | **Get Dictionary Value** | get `Value` for key `headline` in `payload` |
| 5 | **Set Variable** | name `title` |
| 6 | **Get Dictionary Value** | get `Value` for key `summary` in `payload` |
| 7 | **Set Variable** | name `body` |
| 8 | **If** | `title` **has any value** |
| 9 | ↳ **Show Notification** | Title: `title`, Body: `body` |
| 10 | **End If** | — |

No numeric comparison appears anywhere, and that is deliberate. Shortcuts
infers the type of a dictionary value and frequently refuses to treat one as a
number, leaving *has any value* as the only offered condition — or worse,
file properties such as *File Size*. Rather than fight that, the payload omits
`headline` and `summary` entirely when there is nothing to report, so *has any
value* becomes an exact test.

**Step 2 is not optional.** Gist raw URLs are served as `text/plain`, so
**Get Contents of URL** hands back a string rather than a parsed dictionary,
and every **Get Dictionary Value** after it would fail.

To check the wiring, run the shortcut with only steps 1-4 in place. The result
of step 4 should be the headline text. The whole JSON document instead means
step 2 is missing; an empty result while the tracker has published a deal
means the key is misspelled.

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

Once a day at `00:17 UTC`, which is `18:17` in Costa Rica year round — the
country sits at UTC-6 and does not observe daylight saving, so the local time
never drifts. Sale seasons get no special treatment.

`schedule.min_interval_hours` is 20, not 24, and that is deliberate. GitHub
delays scheduled runs by minutes to hours; a strict 24 would skip an entire day
whenever one firing ran late and the next ran on time.

### Cost

About 14 seconds and a handful of HTTP requests per run, so roughly 30 billed
minutes a month against the 2000-minute free tier for private repositories.

### Re-alerting

A game reported once is not reported again at the same price, or a worse one.
It alerts again only when it goes strictly cheaper than the price last
reported. Records are forgotten after `state.retention_days`, so the same game
can alert afresh years later.

A reported deal does stay in the payload for `alerts.repeat_for_days`, which
defaults to 2. The phone polls on a timer rather than receiving a push, so an
alert published and replaced between two polls is never read — and since
publishing records it, it would never be published again. One missed poll used
to cost the deal outright.

The cost is a repeat: the shortcut notifies once per poll while the deal is
still in the payload, so at two polls a day and a two-day window the same game
is announced up to four times. Being told twice about a deal beats being told
about none of it. Set `repeat_for_days` to 0 to publish each alert exactly
once.

The window is anchored to when the deal was *first* reported, not refreshed on
each run, so a month-long sale still stops after two days rather than
notifying daily until it ends.

### Scheduled workflows get disabled

GitHub disables cron workflows in repositories with no commit on the default
branch for 60 days. The tracker writes to a gist and never to this repository,
so a quiet stretch would switch the cron off silently and the alerts would
simply stop.

`keepalive.yml` handles this. It runs on the 1st and 15th of each month and
commits a timestamp only when the last commit is more than 45 days old, so an
active month adds nothing to the history. It is the only workflow with
`contents: write`, and deliberately holds no secrets.

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
