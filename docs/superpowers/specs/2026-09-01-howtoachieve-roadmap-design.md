# HowToAchieve roadmap — design

*1 September 2026. Covers issues #45–#52.*

The web module gains five features, changes language, and changes name. This
records why each decision went the way it did, and in particular what was
measured rather than assumed, so that a later reader can tell a decision from a
preference.

## The shape of the work

| # | Issue | What |
|---|---|---|
| 1 | #45 | Fix: achievement filters render without a SteamID |
| 2 | #46 | Serve the site in English, generated steps included |
| 3 | #47 | Rename to HowToAchieve, move to `howtoachieve.cloudils.com` |
| 4 | #48 | Spanish interface toggle, detected from the browser |
| 5 | #49 | Resolve a pasted Steam profile URL into a SteamID64 |
| 6 | #50 | Completion difficulty, 1–10, from Steam unlock rates |
| 7 | #51 | Estimated completion time, from IGDB |
| 8 | #52 | Upcoming releases with countdowns, from IGDB |

## Why this order

The order is a constraint, not a preference.

Issues #46 and #47 rewrite every user-facing string in the module. Issues #49,
#50, #51 and #52 each add new user-facing strings. Run the features first and
their text is written in Spanish under the old brand, and then has to be
translated and rebranded line by line — the same edit paid for twice, with the
usual result that one or two lines are missed.

So: fix the bug that is already understood (#45), flip the language (#46), move
the name (#47), add the toggle (#48), and only then build features whose text is
born in the right language.

#47 is kept apart from #46 because it is the only piece that touches DNS and
certificates. Separated, it can be reverted on its own.

#52 depends on #51 for the IGDB client and its cached token. It waits rather
than growing a second client.

## Decisions

### Difficulty is computed, not fetched (#50)

The 1–10 difficulty that players recognise is a community vote published by
sites like TrueSteamAchievements. It is not obtainable. Measured directly:

```
truesteamachievements.com   HTTP 403  server=cloudflare  cf-mitigated=challenge
exophase.com                HTTP 403  cf-mitigated=challenge
completionist.me            Cloudflare, content-signal restrictions
```

Every one of them sits behind Cloudflare bot protection. This is the wall
`CLAUDE.md` already cites for SteamDB, and there is an aggravating factor
specific to this project: the site *is* a Cloudflare Worker, so its requests
leave from Cloudflare IPs toward Cloudflare-protected hosts.

The score is therefore derived from the global unlock percentages the page
already downloads — no extra request, no credential, no third party that can
vanish, and full coverage. It is presented as what it is, a measure of rarity,
never as a vote.

The rarest achievement dominates, because completion is gated by the hardest
requirement, adjusted by how many achievements fall in the rare band: fifteen at
3% is a harder game than one fluke at 3% among fifty easy ones. The mapping is
logarithmic, because the gap from 20% to 10% does not mean what the gap from 2%
to 1% means. Reference data:

```
Hollow Knight   rarest 3.90%   median 24.9%   63 achievements
```

Being pure and I/O-free, it is covered by property-based testing: bounded to
1–10, monotonic in rarity, independent of input order, and silent rather than
inventive when there is nothing to score.

*Terminology:* "platinum" is a PlayStation concept. Steam has no platinum
trophy, so the interface says 100% completion.

### Completion time comes from IGDB, not HowLongToBeat (#51)

HowLongToBeat is the reference players know, and its own `robots.txt` disallows
the exact endpoint that would be called:

```
User-agent: *
Disallow: /api
```

The Ziff Davis terms it links prohibit automated retrieval outright, and their
blocklist enumerates crawler user-agents by name. This is not a grey area.

IGDB is official, free, documented, and rate-limited in the open, and its
`game_time_to_beats` endpoint carries completionist times. It authenticates
through Twitch, so it costs two secrets — created by the maintainer, set with
`wrangler secret put`, never committed and never sent to the browser.

Games are matched by Steam app id through IGDB's external-game reference, not by
title. Title matching produces confident wrong answers, which is worse than no
answer.

One credential covers both #51 and #52, which is part of why IGDB won.

### English is the content language; Spanish is an interface option (#46, #48)

The generated achievement steps are the site's substance, and they are generated
once per achievement and cached. Generating them in two languages doubles that:
the Workers AI free tier allows roughly 70 first-time lookups a day, so two
languages would mean about 35 each before the model stops answering for
everyone.

So the content is English only, and the *interface* is translatable. A visitor
whose browser asks for Spanish gets a Spanish interface on first paint —
resolved in the Worker from `Accept-Language`, because resolving it in the
client would render English and then swap, which is visible. An explicit choice
always wins and is remembered.

A stored language preference is a new thing kept in the browser, so
`privacy.html` has to say so. It currently claims the SteamID is the only stored
value, and that claim must stay true.

### The old address keeps working (#47)

`cazalogros.cloudils.com` has been shared, indexed, and listed in the sitemap.
It stays routed to the same Worker and answers 301 to the matching path on the
new host. Nothing already shared dies, and search engines transfer the pages
rather than dropping them.

The Worker itself is not renamed. Renaming a Worker creates a new one and
abandons its rate-limiter namespace and observability history; the route is what
visitors see, and the route is what changes.

### The filters bug is a CSS conflict, not a missing feature (#45)

The logic is already right — `app.js` sets `hidden` when `unlockedCount` is
null, and the API really does return null without a SteamID. But
`.filters { display: flex }` outranks the browser's `[hidden] { display: none }`,
so the element stays visible with the property set.

The repository already documents this exact trap for `.achievement[hidden]`
about a hundred lines further down the same stylesheet. The fix was applied
there and not here, which is why the class of bug is worth grepping for rather
than patching once.

## Constraints that apply throughout

- No build step and no runtime dependency in `web/public/`. The client is served
  as written.
- Every new external call is cached at the edge and degrades to absence, never
  to an error. A missing completion time or an unreachable IGDB must leave the
  page exactly as it is today.
- Input bounds on every public route, following `web/test/validation.test.ts`.
  An unbounded parameter forwarded upstream is free amplification against
  someone else's quota.
- No secret in a log, a response, or the client. `logFailure` already redacts;
  new paths must not defeat it.
- Nothing new is stored server-side. The site has no database, and the privacy
  page says so.
