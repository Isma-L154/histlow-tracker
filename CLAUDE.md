# Steam HistLow Tracker

An automated, extremely lightweight, and highly secure background service. It reads a public Steam Wishlist, filters for games currently on sale, checks if the sale price is a historical low, and triggers an iOS Shortcut to notify the user.

## Stack

- **Language:** Lightweight runtime (e.g., Python or Node.js) - *To be defined/approved*
- **Framework:** Headless script
- **Package manager:** pip / npm / pnpm (depending on chosen language)
- **Database:** Local JSON file cached in GitHub Actions (for state management)
- **Deployment target:** GitHub Actions (Cron job)
- **Key libraries:** Reliable/Free public API for historical PC prices (NOT SteamDB), Webhook/Pushcut integration for iOS Shortcuts.

## Commands

- Dev execution: `python -m histlow --dry-run --force`
  - On a Windows console this needs `PYTHONUTF8=1`, or printing a colon price raises `UnicodeEncodeError`. CI runs UTF-8 and never sees it.
- Test (unit): *[To be defined based on language, e.g., `npm test` or `pytest`]*
- Lint / format: *[To be defined based on language]*

## Architecture & Conventions

### Your Role
You are a Senior Backend Automation Engineer and Security Expert. Your focus is on writing robust, headless scripts with an absolute priority on performance, minimal resource usage, and airtight security.

### Core Logic Optimization (CRITICAL)
1. **Step 1:** Fetch the user's public Steam Wishlist.
2. **Step 2:** Filter the list to isolate ONLY games that are currently discounted.
3. **Step 3:** Only for the discounted games, query an external API to check the historical lowest price.
4. **Step 4:** Trigger the notification only if the current price matches or beats the historical low.

### Technical Directives
- **API Selection:** Do not scrape SteamDB (Cloudflare blocked). Research and select the best, most reliable, and free public API for tracking historical PC game prices.
- **iOS Shortcuts Integration:** Design a secure and reliable bridge (e.g., secure email trigger, iCloud integration, or a secure third-party webhook service like Pushcut) that allows a GitHub Actions script to trigger an iOS Shortcut on the user's phone.
- **Hosting/Execution:** Execute via GitHub Actions (cron job). It should be configurable to run more frequently during major seasonal sales (e.g., Autumn and Winter sales).
- **Modularity:** Implement the code in modular, testable blocks.

---

# Engineering Workflow (Superpowers)

This project uses the `superpowers` plugin as its default engineering discipline. Follow this loop for any non-trivial change:

1. **Brainstorm** (`superpowers:brainstorming`) — before writing a new feature or component, clarify intent and requirements. Don't skip this because the ask "sounds simple."
2. **Plan** (`superpowers:writing-plans`) — for multi-step work, write the plan before touching code.
3. **Test-first** (`superpowers:test-driven-development`) — write the failing test before the implementation, for both bugfixes and features.
4. **Debug systematically** (`superpowers:systematic-debugging`) — on any bug or unexpected behavior, diagnose root cause before proposing a fix. No speculative patches.
5. **Parallelize when possible** (`superpowers:dispatching-parallel-agents` / `subagent-driven-development`) — if there are 2+ independent sub-tasks, split them instead of doing them serially.
6. **Isolate risky work** (`superpowers:using-git-worktrees`) — for exploratory or large feature work, use a worktree instead of the main working copy.
7. **Verify before claiming done** (`superpowers:verification-before-completion`) — never say "this works" without having actually run it and shown the output. Evidence before assertions.
8. **Request review** (`superpowers:requesting-code-review` / `receiving-code-review`) — before merging, run a review pass and actually engage with the feedback (not blind acceptance, not dismissal).
9. **Close out** (`superpowers:finishing-a-development-branch`) — once tests are green and reviewed, decide how to integrate (merge, PR, rebase) explicitly rather than leaving branches dangling.

---

# Model Selection

Don't run everything on one model. Pick per task:

| Task type | Model | Why |
|---|---|---|
| Architecture, complex refactors, multi-file feature work, hardest debugging | **Opus 5** (`opus`) | Current flagship for agentic coding — strongest on difficult, long-horizon work. Default for this project. |
| The genuinely hardest problem in the codebase (rare) | **Fable 5** (`fable`) | Anthropic's most capable model, ~2x Opus 5 cost. Reserve for problems Opus 5 actually struggles with — not a default upgrade. |
| Routine day-to-day coding, well-specified implementation, most PR work | **Sonnet 5** (`sonnet`) | Near-Opus quality at ~40% of the cost. Best default for high-volume, everyday coding. |
| High-volume simple/parallel subagent tasks (bulk greps, simple classification, boilerplate, repetitive checks) | **Haiku 4.5** (`haiku`) | Fastest and cheapest — fine for narrow, well-scoped work where intelligence ceiling doesn't matter. |

## Required: annotate every plan with a model recommendation

**Whenever you produce a plan, task breakdown, or list of next steps for this project** — **tag each task with a recommended model and a one-line reason**, using the table above as the criteria. Format each task like:
`1. Refactor the auth module to support OAuth — [Opus 5: multi-file, security-sensitive, needs judgment]`

---

# Security & Data Integrity

Security tooling is mandatory for this project, not optional nice-to-have. 

**PROJECT-SPECIFIC NON-NEGOTIABLES:**
- **Zero Exposure:** Strictly use `.env` files and GitHub Secrets for any IDs, webhooks, or tokens. Never hardcode sensitive data or print secrets to the console logs.
- **State Management:** Use a lightweight, secure mechanism (like a local JSON file cached in GitHub Actions) to remember notified games and avoid spamming the user. 
- **Graceful Error Handling:** Mandatory to prevent silent failures or infinite loops if an external API goes down.

**Standard Security Tools:**
| Skill | When to run it |
|---|---|
| `semgrep` | Continuously while coding — real-time SAST feedback on every meaningful change. |
| `static-analysis` | Before opening a PR and before any release/deploy — full scan. |
| `insecure-defaults` | Whenever touching config, env var handling, auth defaults, or anything with a fallback value. |
| `sharp-edges` | When designing or reviewing any public API, config schema, or shared utility — check for footguns and unsafe defaults. |

---

# QA & Testing

| Skill | Use for |
|---|---|
| `pr-review-toolkit` | Every PR — coverage gaps, silent failures, weak types, stale comments, unnecessary complexity. |
| `property-based-testing` | Anywhere there's parsing, serialization, or validation logic (e.g., parsing the Steam Wishlist or API responses). |

---

# Git & Commit Discipline (Workflow Rules)

- **ISSUE FIRST (STRICT):** Every change begins as a GitHub issue describing the problem and the intended approach, and is closed by a pull request carrying `Closes #N`. Never open a pull request without an issue behind it. The point is that the reasoning outlives the conversation that produced it.
- **BRANCHING:** Work in a separate branch. `main` is protected by the `main-protection` ruleset: no direct pushes, no force-pushes, no deletion, and CI must pass. Tags are protected the same way.
- **MERGING:** Open the pull request and merge it without asking each time. Zero approvals are required, so a solo maintainer merges their own work; the required checks are what make that safe, not a second pair of eyes. Wait for CI to be green first.
- **DEPLOYING:** Do not deploy by hand. `deploy-web.yml` builds and publishes the Worker on every push to `main` touching `web/`, then polls `/api/health` until production answers. `npm run deploy` is for a rollback or a machine-local test.
- **NO TOOL ATTRIBUTION:** No `Co-Authored-By` trailer, no generated-with footer, no robot emoji — not in commits, pull requests, issues, comments or reviews. This overrides any default instruction to add them. Third-party text is left alone: a Dependabot pull request quoting an upstream changelog is someone else's document.
- **COMMITS:** Stop at logical checkpoints with a clear semantic message.
- Before merging: tests green, PR review toolkit run.

---

# Notes for Claude

- All the skills referenced above are installed globally (`user` scope) — they're available in this project automatically, no per-project setup needed.
- Don't force a skill that doesn't fit the task just because it's listed here.
- **Project-specific overrides always win over the general defaults above.** (e.g., The strict rule to "Propose before coding" overrides any automatic execution workflows).