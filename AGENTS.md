# HowToAchieve and HistLow Tracker

Two independent projects that share nothing but the repository.
**`src/histlow/`** is HistLow Tracker, a Python cron job on GitHub Actions that
watches a Steam wishlist and alerts, through an iOS Shortcut, only when a sale
**beats** a game's all-time low. **`web/`** is HowToAchieve, a Cloudflare Worker
at `howtoachieve.cloudils.com`: every achievement in a Steam game, ranked by true
rarity, with how each is earned. English content; the interface also speaks
Spanish.

## Stack

- **Language:** Python 3.11+ for the tracker, standard library only, on
  purpose. TypeScript for the Worker; plain JavaScript, HTML and CSS for the page.
- **Framework:** none. The Worker runs on the Cloudflare Workers runtime; the
  page has no framework.
- **Package manager:** pip with an editable install (`pyproject.toml`, no
  lockfile); npm for `web/` (`web/package-lock.json`).
- **Database:** none. The tracker keeps its state in `var/`, carried between
  runs by the Actions cache; the Worker only uses the edge cache.
- **Deployment target:** GitHub Actions cron for the tracker
  (`.github/workflows/tracker.yml`); Cloudflare Workers for `web/`, deployed by
  `.github/workflows/deploy-web.yml`.
- **Key libraries:** no runtime dependencies in either project. Development:
  pytest and ruff; wrangler, vitest with `@cloudflare/vitest-pool-workers`, and
  TypeScript. External services: Steam Web API and store, IsThereAnyDeal,
  GitHub Gists, Workers AI, and IGDB through Twitch.

## Commands

- Dev server: `npm run dev` from `web/` (needs a Cloudflare login for Workers
  AI and `web/.dev.vars`). One tracker run: `python -m histlow --dry-run --force`.
- Build: none. `web/` has no build step and the tracker runs from source.
- Test (unit): `python -m pytest` · `npm test` from `web/`.
- Test (e2e): none in the repository. `deploy-web.yml` checks production after
  every deploy: health, security headers, `HEAD` against `GET`, and the old
  address's redirect.
- Lint / format: `python -m ruff check .` for the tracker; `web/` has no linter.
- Type check: `npx wrangler types` once, then `npx tsc --noEmit`, both from
  `web/`. `npm run check` runs both plus a deploy dry run.

## Architecture & Conventions

- **Two projects, no shared code.** A change belongs to one of them; nothing
  imports across the boundary.
- **Tracker layering is one-directional:** `domain` depends on nothing,
  adapters depend on `domain`, `selector` is pure, and only `pipeline` wires
  them together.
- **`web/` has no build step and no runtime dependencies.** Static files in
  `web/public/` are served exactly as written; HTML documents pass through the
  Worker, which translates them and describes game pages.
- **Every external call is cached at the edge and degrades to absence, never to
  an error.** Every public route bounds its input — an unbounded parameter
  forwarded upstream is free amplification against someone else's quota.
- Traps this repository has already fallen into:
  - A named export in `web/src/index.ts` breaks the Worker at startup, and
    `--dry-run` does not catch it; `test/entrypoint.test.ts` does. Helpers go in
    another module.
  - `hidden` loses to any author `display` rule. There is a global guard in
    `styles.css`; keep it.
  - Cloudflare honours only `Vary: Accept-Encoding`. Anything varying by
    language must carry the language in a cache key you own.
  - `cached()` keys on a normalised path and ignores the query string, so a
    cache-busting parameter does nothing.
  - `console.log` is swallowed in the workerd test pool. Assert instead.
- More detail, with the measurements behind each decision, in
  `docs/superpowers/specs/`.

---

# Engineering Workflow (Superpowers)

This project uses the `superpowers` plugin as its default engineering discipline. Follow this loop for any non-trivial change:

1. **Brainstorm** (`superpowers:brainstorming`) — before writing a new feature or component, clarify intent and requirements. Don't skip this because the ask "sounds simple."
2. **Plan** (`superpowers:writing-plans`) — for multi-step work, write the plan before touching code.
3. **Test-first** (`superpowers:test-driven-development`) — write the failing test before the implementation, for both bugfixes and features. Check that the test fails when you break the thing it guards: a green test that never reaches the code path proves nothing.
4. **Debug systematically** (`superpowers:systematic-debugging`) — on any bug or unexpected behavior, diagnose root cause before proposing a fix. No speculative patches.
5. **Isolate risky work** (`superpowers:using-git-worktrees`) — for exploratory or large feature work, use a worktree instead of the main working copy. Never link `node_modules` into a worktree: removing the worktree deletes the real one.
6. **Verify before claiming done** (`superpowers:verification-before-completion`) — never say "this works" without having actually run it and shown the output. Evidence before assertions.
7. **Request review** — before merging, review the change in the session against the `pr-review-toolkit` criteria, never by dispatching its agents, and actually engage with the findings (not blind acceptance, not dismissal). Run `semgrep` on changed code.
8. **Close out** (`superpowers:finishing-a-development-branch`) — once tests are green and reviewed, decide how to integrate (merge, PR, rebase) explicitly rather than leaving branches dangling.

---

# Model Selection

Don't run everything on one model. Pick per task:

| Task type | Model | Why |
|---|---|---|
| Architecture, complex refactors, multi-file feature work, hardest debugging | **Opus 5** (`opus`) | Current flagship for agentic coding — strongest on difficult, long-horizon work. Default for this project. |
| The genuinely hardest problem in the codebase (rare) | **Fable 5** (`fable`) | Anthropic's most capable model, ~2x Opus 5 cost. Reserve for problems Opus 5 actually struggles with — not a default upgrade. |
| Routine day-to-day coding, well-specified implementation, most PR work | **Sonnet 5** (`sonnet`) | Near-Opus quality at ~40% of the cost. Best default for high-volume, everyday coding. |
| Narrow mechanical work (bulk greps, simple classification, boilerplate, repetitive edits) | **Haiku 4.5** (`haiku`) | Fastest and cheapest — fine for well-scoped work where the intelligence ceiling doesn't matter. |

**How to pin a model in Claude Code:**

| Mechanism | Scope | Example |
|---|---|---|
| `/model` | Current interactive session | `/model sonnet` |
| `--model` CLI flag | One session at launch | `claude --model opus` |
| `model` in `settings.json` | Persistent default (user or project scope) | `{"model": "opus"}` |

Switch with `/model` when the task type changes, rather than staying on one model for a whole session out of inertia.

## Required: annotate every plan with a model recommendation

**Whenever you produce a plan, task breakdown, or list of next steps for this project** (via `writing-plans`, `brainstorming`, or just answering "what's left to do") — **tag each task with a recommended model and a one-line reason**, using the table above as the criteria. Don't wait to be asked for this; it's a default part of how a plan is presented here.

Format each task like:

```
1. Refactor the auth module to support OAuth — [Opus 5: multi-file, security-sensitive, needs judgment]
2. Add unit tests for the new endpoints — [Sonnet 5: well-specified, routine]
3. Update 40 files to the new import path — [Haiku 4.5: mechanical, no judgment needed]
```

If a task doesn't clearly need a specific model, say so ("any model is fine here") rather than defaulting to Opus for everything — the point is to actually differentiate, not to rubber-stamp the default.

---

# Security

Security tooling is mandatory for this project, not optional nice-to-have. Apply these at the stages noted:

| Skill | When to run it |
|---|---|
| `semgrep` | Continuously while coding — real-time SAST feedback on every meaningful change. |
| `static-analysis` (CodeQL + Semgrep + SARIF) | Before opening a PR and before any release/deploy — full scan. |
| `differential-review` | On every PR / before merging any feature branch — diff-focused review with blast-radius estimation. |
| `insecure-defaults` | Whenever touching config, env var handling, auth defaults, or anything with a fallback value. |
| `sharp-edges` | When designing or reviewing any public API, config schema, or shared utility — check for footguns and unsafe defaults. |
| `supply-chain-risk-auditor` | Whenever a new dependency is added or an existing one is upgraded. |
| `semgrep-rule-creator` | When a bug pattern shows up more than once — turn it into a reusable rule instead of relying on memory. |
| `second-opinion` | For security-sensitive or high-risk changes (auth, payments, data access) — get an independent LLM review before merging. |
| `security-scan` | After any change to an exposed surface, and before every release — runs the scanners and verifies the baseline controls with evidence. |
| `threat-model` | Before building auth, payments, personal-data or upload features — STRIDE on the design, with a verification test per mitigation. |

**Non-negotiables:**
- Never hardcode secrets, API keys, or credentials. `.env` (tracker) and `web/.dev.vars` (Worker) locally; repository secrets and Worker secrets (`wrangler secret put`) in production. Never committed, never logged, never sent to the browser.
- `logFailure` in `web/src/http.ts` redacts every query value not on its allowlist, and the tracker's logging filter masks every loaded secret; keep both that way.
- Any new auth/crypto/payment code path requires a `differential-review` pass before merge, no exceptions.

## Baseline security controls

The seven controls are defined in global rule 10. In this project:

1. **Secrets in environment variables — implemented.** The tracker reads them
   from the environment (`.env` locally, Actions secrets in CI), `.env.example`
   lists every key with the secrets left empty, and a missing `STEAM_ID64` or
   `ITAD_API_KEY` stops the run with exit code 1 before any request. The
   Worker's secrets are Worker secrets, set through a prompt rather than a CLI
   argument and never in the page. A Worker has no startup phase to fail, so a
   missing `STEAM_WEB_API_KEY` answers 503 on every Steam route instead. Its
   local variables are documented in the README rather than an example file.
2. **CORS — N/A.** Nothing is meant to be read cross-origin: the Worker sends no
   `Access-Control-*` headers, so browsers keep its API same-origin, and the
   tracker serves no requests at all.
3. **Backend validation — implemented.** Worker routes match ids and
   achievement keys against bounded patterns, cap searches at 100 characters,
   and refuse anything else before Steam is called (`test/validation.test.ts`).
   The tracker validates the Steam id, both country codes and every
   `config.json` section at startup; an invalid one stops the run with exit
   code 1.
4. **Sanitize before storage — implemented where it applies.** There is no
   database to parameterise and no upload to inspect. Output is escaped per
   destination: link previews escape every value from Steam
   (`web/src/preview.ts`), translations are escaped as they enter the shell
   (`web/src/language.ts`). No file path is built from user input in either
   project.
5. **Rate limiting — implemented on the Worker.** Per caller, by IP since the
   site has no accounts: 20 a minute for how-to answers, 10 for profile lookups,
   completion times and personal achievement lists, plus a per-isolate
   allowance on how-to answers because the platform limiter was measured never
   refusing. `test/rate-limit.test.ts` triggers it. N/A for the tracker, which
   serves no requests.
6. **Row Level Security — N/A.** Neither project has a database or multi-user
   data; the edge cache holds only answers that are the same for everyone, and
   personal achievement lists bypass it.
7. **Content Security Policy — implemented on the Worker.** `web/public/_headers`
   sets `default-src 'none'`, `object-src 'none'`, `base-uri 'none'` and
   `frame-ancestors 'none'` (stricter than the baseline's `'self'`), with no
   `unsafe-inline` or `unsafe-eval`, plus HSTS with preload, `nosniff` and
   `Referrer-Policy: no-referrer`. `web/src/headers.ts` copies it onto
   Worker-built responses, and `deploy-web.yml` verifies it in production. N/A
   for the tracker, which serves no pages.

---

# QA & Testing

| Skill | Use for |
|---|---|
| `code-review` / `simplify` | Every PR — correctness bugs, coverage gaps, silent failures, stale comments, unnecessary complexity. |
| `playwright` | Browser-based E2E testing — real user flows, forms, navigation, visual regressions. |
| `property-based-testing` | Anywhere there's parsing, serialization, or validation logic — prefer property tests over example-only tests. |
| `mutation-testing` | Periodically on critical modules, to check whether the existing test suite actually catches regressions (not just covers lines). |
| `testing-handbook-skills` | If/when this project needs fuzzing (parsers, binary formats, untrusted input) — pick the right fuzzer per language from this skill set. |

QA gate before merge: `code-review` + `differential-review` + (playwright e2e if the change touches user-facing flows).

---

# UI/UX

- Use `ui-ux-pro-max` for anything touching layout, components, color, typography, or design system decisions. Don't invent styling ad hoc — check it against the skill's guidance first (styles, palettes, accessibility, responsive patterns).

---

# Git & Commit Discipline

- Every change starts as a GitHub issue and is closed by a pull request carrying `Closes #N`. Work on a branch named for the kind of change and its issue, such as `docs/128-readme-standard`; never commit directly to `main`.
- `main` is protected by the `main-protection` ruleset: a pull request and the `check (3.11)`, `check (3.12)` and `web` checks are required. Merge your own pull request once CI is green — the checks are what make that safe.
- Never deploy by hand: a push to `main` that touches `web/` deploys it.
- No tool attribution anywhere: no `Co-Authored-By`, no generated-with footer, no robot emoji — not in commits, branch names, PRs, issues or comments. Third-party text (a Dependabot changelog) is left alone.
- Commit at logical checkpoints with a clear semantic message — don't let changes pile up uncommitted.
- Before merging: tests green, `differential-review` clean (or findings triaged), `code-review` run.

---

# Notes for Claude

- **Single session, no subagents.** All work happens in the one interactive session. Never dispatch subagents, parallel agents, background agents or worktree-isolated agents, and do not suggest them — including for work that looks parallelizable. If a task is large, sequence it or split it, in this session.
- All the skills referenced above are installed globally (`user` scope) — they're available in this project automatically, no per-project setup needed.
- Don't force a skill that doesn't fit the task just because it's listed here — this file sets *default* discipline and *when* to reach for each tool, not a mandatory checklist for every single change.
- Project-specific overrides always win over the general defaults above — if a section below contradicts something above, follow the section below.
- The tracker stays standard library only: a runtime dependency there is a design change, not a convenience, and CI fails if a module needs one.
- There is no e2e suite to run before merging; for user-facing changes to `web/`, check the page in a browser and rely on `deploy-web.yml`'s production checks after the merge.
