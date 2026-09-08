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
| 8 | **Get Dictionary Value** | get `Value` for key `alert_id` in `payload` |
| 9 | **Set Variable** | name `newid` |
| 10 | **Get File** | path `Shortcuts/histlow-seen.txt`, **Error If Not Found off** |
| 11 | **Set Variable** | name `seen` |
| 12 | **If** | `newid` **has any value** |
| 13 | ↳ **If** | `seen` **is not** `newid` |
| 14 | ↳ ↳ **Show Notification** | Title: `title`, Body: `body` |
| 15 | ↳ ↳ **Text** | `newid` |
| 16 | ↳ ↳ **Save File** | path `Shortcuts/histlow-seen.txt`, **Overwrite on**, *Ask Where To Save* off |
| 17 | ↳ **End If** | — |
| 18 | **End If** | — |

### Why the shortcut remembers

Steps 8-17 are what stop one deal producing one notification per poll. A deal
stays in the payload for `alerts.repeat_for_days` and the phone polls several
times a day, so without a memory the same alert is announced every time it is
read.

`alert_id` is a fingerprint of the games and prices being announced, and
deliberately not of `generated_at`: it stays identical while the same deal is
republished, and changes the moment a game joins or a price drops further. The
shortcut stores the last one it acted on and compares.

**Turn "Error If Not Found" off** on step 10. The file does not exist until the
first notification is shown, and the default is to abort the whole shortcut.

The outer `If` on step 12 is not redundant. When there is nothing to report the
payload carries no `alert_id`, so `newid` is empty — and an empty value differs
from whatever was stored, which without that guard would show an empty
notification every time a sale ended.

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
day.

---

## Operating notes

### Cadence

The workflow fires twice a day, at `00:23 UTC` and `12:23 UTC` — `18:23` and
`06:23` in Costa Rica year round, since the country sits at UTC-6 and does not
observe daylight saving, so the local times never drift. Sale seasons get no
special treatment.

Do not read those as the hours you will be notified at. GitHub delivers
scheduled runs late by anything from one hour to eleven, so no cron can be
aimed at a particular local hour. Two firings twelve hours apart bound the wait
instead of trying to hit a target: with the typical four-hour delay one refresh
lands mid-morning and the other late evening, bracketing the polling times in
step 7.

Once a day was not enough. A sale that starts in the afternoon is invisible
until the next morning's run — Resident Evil Requiem reached a new all-time low
thirteen hours after that day's only firing and sat unpublished until it was
dispatched by hand.

`schedule.min_interval_hours` is 1, the loosest the validator allows, and that
is deliberate.

The setting stops the same work being done twice. A manual dispatch is not the
case it covers: **force** defaults to on and the gate returns on it before the
interval is ever consulted, so a dispatch is never blocked. What remains is a
duplicated delivery of the same cron, and a scheduled run landing right after a
manual dispatch that already recorded the run — both a matter of seconds to
minutes. Every hour of interval beyond that is an hour in which a legitimate
firing is silently dropped instead.

The arithmetic: the firings are nominally twelve hours apart, and GitHub
delivered the observed ones `1h35m` to `11h07m` late — a swing of `9h32m`, so
two can land as little as `2h28m` apart. The gate opens at
`min_interval_hours` minus the 20-minute drift grace:

| Value | Gate opens at | Headroom over a `2h28m` gap |
| --- | --- | --- |
| **1** | `40m` | `1h48m` |
| 2 | `1h40m` | `48m` |
| 3 | `2h40m` | drops the run |

The headroom is worth having because that delay range was measured entirely on
the `12:23` firing — the `00:23` slot has never run, and the workflow's own
comment notes that GitHub's queueing depends on the hour requested.

### Cost

About 14 seconds and a handful of HTTP requests per run. Nothing is billed:
this repository is public, and Actions minutes are unmetered for public
repositories. The 2000-minute free tier that earlier notes weighed this against
is a private repository's accounting and never applied.

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

That would mean one notification per poll while the deal lingers, so the
payload also carries `alert_id` and the shortcut remembers the last one it
acted on. A republication of the same deal is recognised and stays silent: one
notification per distinct alert, however often the phone looks.

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
