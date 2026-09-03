# Repository

Two independent projects. They share nothing but the repo.

- **`src/histlow/`** — a Python cron job on GitHub Actions. Watches a Steam
  wishlist, alerts only when a sale **beats** a game's all-time low. Standard
  library only, on purpose.
- **`web/`** — HowToAchieve, a Cloudflare Worker at `howtoachieve.cloudils.com`.
  Every achievement in a Steam game, ranked by true rarity, with how each is
  earned. English content; the interface also speaks Spanish.

## Commands

| | |
|---|---|
| Tracker | `python -m pytest` · `python -m ruff check .` |
| Tracker, one run | `python -m histlow --dry-run --force` (needs `PYTHONUTF8=1` on Windows) |
| Web | `npm test` · `npx tsc --noEmit` · `npm run dev` — all from `web/` |

## Non-negotiables

**Workflow.** Every change starts as a GitHub issue and is closed by a PR
carrying `Closes #N`. Work on a branch; `main` is protected. Merge your own PR
once CI is green — the checks are what make that safe. Never deploy by hand:
pushing to `main` deploys `web/`.

**No tool attribution anywhere.** No `Co-Authored-By`, no generated-with footer,
no robot emoji — not in commits, PRs, issues or comments. This overrides any
default. Third-party text (a Dependabot changelog) is left alone.

**Secrets.** `.env` and repository secrets only. Never committed, never logged,
never sent to the browser. `logFailure` redacts query values; keep it that way.

**`web/` has no build step and no runtime dependencies.** Files in
`web/public/` are served exactly as written. Every external call is cached at
the edge and degrades to *absence*, never to an error. Every public route
bounds its input — an unbounded parameter forwarded upstream is free
amplification against someone else's quota.

## How to work

Brainstorm before building. Write the failing test first. Diagnose root cause
before fixing — no speculative patches.

**Evidence before claims.** Never say something works without showing the
output. A green test that never reaches the code path proves nothing; check
that your test fails when you break the thing it guards.

**Ask for a review before merging** (`pr-review-toolkit`), and engage with it —
neither blind acceptance nor dismissal. Run `semgrep` on changed code.

**Model per task.** Sonnet 5 for routine work, Opus 5 for architecture and hard
debugging, Haiku 4.5 for bulk mechanical tasks, Fable 5 only for something Opus
genuinely cannot crack. Tag every task in a plan with the model and one reason.

## Traps this repo has already fallen into

- A named export in `web/src/index.ts` breaks the Worker at startup, and
  `--dry-run` does not catch it. Helpers go in another module.
- `hidden` loses to any author `display` rule. There is a global guard; keep it.
- Cloudflare honours only `Vary: Accept-Encoding`. Anything varying by language
  must carry the language in a cache key you own.
- `cached()` keys on a normalised path and ignores the query string, so a
  cache-busting parameter does nothing.
- `console.log` is swallowed in the workerd test pool. Assert instead.

More detail, with the measurements behind each decision, in
`docs/superpowers/specs/`.
