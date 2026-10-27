# AGENTS.md

This guide is for coding agents (Codex, Gemini/agy or others) that take over this repository. Read this whole file before you start work.

This project is **Daily**: a news site on one Cloudflare Worker. It finds hot topics by itself and writes its own daily digest. It has a single admin and many sections.
The production site is <https://news.ioenv.com>. The repository is `githonllc/ainews`. The top-level epic is #26.

---

## 1. Read in this order before you start

| Order | File                                        | Purpose                                                                                       |
| ----- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1     | `docs/plan/Newsren_Plan.md`                 | Product requirements. You **must meet them**. Cite them as `N§x`                              |
| 2     | `docs/design/decisions.md`                  | Scope and technical decisions the owner confirmed. Added by round                             |
| 3     | `docs/architecture/architecture.md`         | **Architecture contract**. Every issue follows it. To change the contract, open a separate PR |
| 4     | This file                                   | Current state, process, red lines, remaining work                                             |
| 5     | The **body and all comments** of your issue | Comments hold decisions and fixes made after the body was written                             |

Priority when requirements conflict: `Newsren_Plan.md` > `decisions.md` > `architecture.md` > issue body > code comments.
If you find a conflict, stop. Write down the original text of both sides. Ask the owner. Do not pick one yourself.

---

## 2. Current state (snapshot: 2026-10-24; the numbers below will go stale, so re-check them with the commands in §7)

**Live** (all of M0, part of M1):

| issue | What                                                                                     | Key files                                                      |
| ----- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| #2–#4 | Skeleton, deployment, CI; data model, model client and call ledger; admin Access auth    | `src/server.ts`, `src/providers/`, `src/server/admin/`         |
| #5    | RSS / list-page collection, dedup, source health                                         | `src/pipeline/collect/`                                        |
| #6    | Body fetch ladder tiers 0–3, robots, per-host rate limit                                 | `src/pipeline/body/`                                           |
| #7    | Pre-filter, five-dimension scoring, tags, summary (Jev + Gemini)                         | `src/pipeline/analyze/`                                        |
| #8    | Seed config for four sections (Technology, Education, Industry, Finance) and two sources | `src/server/db/seed/`                                          |
| #10   | Public site `/`, `/s/$section`, RSS                                                      | `src/routes/`, `src/server/publication/`                       |
| #43   | Fix for summaries cut off by thinking tokens                                             | `src/pipeline/analyze/prompts.ts`, `src/providers/adapters.ts` |

**Production switches** (top-level `vars` in `wrangler.jsonc`): `COLLECT_ENABLED="true"`, `MODEL_CALLS_ENABLED="true"`.
`THIRD_PARTY_READER_ENABLED`, `EMAIL_ENABLED` and `DISCOVERY_ENABLED` are all `"false"`. In `env.test`, all five are `"false"`.

**Production data**: two sources (arXiv cs.AI, MIT Technology Review) are fetched every hour. All four sections have `publish_mode='review'`.
So **no article is approved, and the public site is empty**. Approval must wait until the admin review queue (#9) goes live.

**Budget**: $2 per day. It is stored per channel in `budget.caps` in `settings`: `gateway` $1.90 (Jev, Gemini),
`workers_ai` $0.10 (embeddings), `jina` $0. The `llm_calls` ledger rejects a call before it exceeds the cap.

**In progress** (check the real state on GitHub when you take over):

- #46 is a one-time backfill of the last 3 days of articles from the two sources. The PR is #48. The flow is: review → merge →
  run `--dry-run` and show it to the owner → run `--apply` after the owner confirms.
- 16 articles that had no summary before #43 were reset to `body_ready`. The catch-up queue analyzes them again. A new analysis
  inserts a new `analyses` row with the new `prompt_version`. The old empty-summary row stays. So when you check, look only at the row with the latest `prompt_version` for each article.

---

## 3. Remaining work

### 3.1 M1 · Stage 1 (finish this first)

M1 gate (#26): Technology is collected continuously for more than 24 hours; a daily digest has been published; every item has been reviewed;
the ledger has `completed` rows for real calls; `spent_micros > 0` in `budgets` for the current day; and the numbers match the AI Gateway log.

| Order    | issue                                                 | Tier   | Depends on | Notes                                                                                                                                                                                        |
| -------- | ----------------------------------------------------- | ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | #46 Backfill 3 days                                   | opus   | —          | See above                                                                                                                                                                                    |
| 2        | #45 Blank area on home page at 1280px                 | sonnet | —          | Small UI change. **The owner must approve screenshots before merge**                                                                                                                         |
| 3        | #9 Admin: sections, sources, review queue             | opus   | #10 ✅     | Read its 6 comments first (column names, restore source, re-analysis, write NULL on override, corrections index, embed billing channel)                                                      |
| 4        | #11 Event grouping and timeline                       | opus   | #9         | Use `Q_GROUP` (concurrency 1) and Vectorize `V_EVENTS`. Process each batch in order with `for…of`. Candidates = Vectorize recall ∪ events created in D1 in the last 30 minutes (contract §6) |
| 5        | #12 Daily digest and admin email                      | opus   | #11        | Labeled `needs-owner`: the owner must first set up Email Service and confirm the sender address                                                                                              |
| Parallel | #34 Architecture test checks transitive imports       | sonnet | —          | Test change                                                                                                                                                                                  |
| Parallel | #39 REST endpoint of `restTransport` returns No route | —      | —          | Production uses only the binding, so this does not block. Not refined                                                                                                                        |

**The implementation refinement (`## 实现细化`, the markdown heading of the refinement comment) of #9, #11 and #12 was written on 2026-10-22, when the repository had no code yet.** For each issue that is already done, 7–13 items were corrected before work started
(file names, table columns, function signatures, test method). So before you start, check every path, column name and function in the refinement against the current code.
Post the corrections as an issue comment. Then write code. If the refinement and the code conflict, the code and the contract win. Say so in the PR body.

### 3.2 M2–M4 (#13–#25)

These issues have only scope and acceptance criteria. They are labeled `needs-refine`. Before you dispatch or start work, write the implementation refinement: read the requirements and the existing code. Give the exact change points,
invariants, command-level acceptance and the execution tier (`### 执行档位`, the markdown heading of the execution-tier slot). Post it as a comment on the issue. Then change the label to `refined`. Order the work by the "Depends on" line in the issue body.

| Milestone | issue   | Gate                                                                                            |
| --------- | ------- | ----------------------------------------------------------------------------------------------- |
| M2        | #13–#16 | Every claim on an event page links to a source passage; Ask refuses questions it cannot look up |
| M3        | #17–#19 | A watch hits only on real progress, and never hits twice for the same progress                  |
| M4        | #20–#25 | All four sections are online; every number in an earnings report links to a filing              |

---

## 4. Red lines (if you break any one, the PR cannot merge)

### Switches and spending

- The five safety switches accept only the string `"true"`. **A feature PR does not change switches.** To change a switch, open a separate PR that changes only those lines, and get explicit consent from the owner.
- Any action that spends real money (turning on a switch, a script that makes real model calls, Jina) needs the owner's consent first. State the expected amount.
- All model and Jina calls go through `createModelClient()` in `src/providers/models.ts`. Never call `env.AI.run` directly.
  It handles the switch check, the `llm_calls` ledger, and budget reservation and settlement.
- Money is always an integer in micro-dollars (1 USD = 1,000,000).
- Gemini thinking tokens count toward `maxOutputTokens`. A new `write` / `reason` call must set thinking explicitly (see
  `WRITE_THINKING = { thinkingLevel: "low" }`). Before you merge, use a few real calls to prove that `finishReason` is `STOP`
  (`scripts/probe-write.ts` is a ready-made probe script). This is how #43 went wrong: thinking used up all 2000 tokens, and 16 articles got no summary.

### Database

- **Do not write a migration that rebuilds a table.** For `articles` and every table that a foreign key references, use only `ALTER TABLE … ADD COLUMN` or `CREATE INDEX`.
  To change a CHECK or a unique key, first open an issue to design the migration. Generate migrations with `npm run db:generate`. After you generate one, run it again. It must print "No schema changes".
- A statement that writes `articles.stage` also writes `stage_updated_at = now` and `requeue_count = 0`, and it carries an "expected old stage" condition.
- Use D1 `batch()` for writes to several tables. When "the next step runs only if the previous step succeeded", chain the steps with `WHERE changes() = 1`
  (tested on remote D1: `changes()` returns the number of rows the previous statement in the same batch changed). See `src/pipeline/analyze/analyze.ts`.
- Store bodies by version: `bodies/{article_id}/{sha256}.md`. Never overwrite. Claim evidence cites a specific version. `feed/{sha256(canonical_url)}.html`
  is the raw input from collection. It may be overwritten. It is not a body version.
- Event revision (contract §6): when the "set of approved articles" in an event changes, `events.revision + 1`. Approve and reject must change the revision in the same
  `batch()`. An event artifact is written only if its `input_revision` equals the current revision. This stops an old job from overwriting a new result.
- The logical key in the ledger must include every input that decides the result (for example the body `body_sha`). Otherwise a changed input gets the old answer back.
- `promptVersion` (`src/pipeline/analyze/questions.ts`) is a hash that is computed automatically from the request that is actually sent. Bump `ANALYZE_CODE_VERSION` by hand only when you change the `state` fields,
  the scoring logic or the storage format.

### Publication and security

- Public pages and RSS read data only through `src/server/publication/`. "Approved" has one definition: `approvedArticleWhere`
  (`src/server/publication/articles.ts`). Do not write a second one.
- Finance is always reviewed by a human. Use the `FINANCE_SLUG` constant and `effectivePublishMode()` (`src/pipeline/analyze/analyze.ts`) to decide.
  Every Finance page shows a disclaimer.
- Model output and source content are untrusted data. Links allow only http/https (`safeHttpUrl`, `src/lib/url.ts`). Sanitize markdown before you render it.
  A Jev choice must be one of the options.
- Check robots.txt before you fetch. Use the project UA. Obey crawl-delay (`claimHostSlot`). Fetch only source domains and the section `primary_domains`.
  Do not accept sources that need browser rendering.
- Admin auth: the request path of a server function is `/_serverFn/*`. It is not under `/admin`, which Access protects. So every admin server
  function must explicitly attach the Access middleware from `src/server/admin/`. Write operations use POST, so that they go through the Origin check in `src/server/edge.ts`.
- Public code must not touch models: `routes/**` and `server/publication/**` must not import `pipeline/**` or `providers/**`, directly or indirectly
  (`tests/architecture.test.ts`, rule R1).

### Configuration and environment

- If you change `wrangler.jsonc`, run `npx wrangler types` and commit the updated `worker-configuration.d.ts` (CI checks it with `--check`).
- If local tests need a new binding, also add it to `env.test`. Tests must not depend on Cloudflare credentials or the real network.
- `.env.prod` holds production secrets. Never put it in git. Never print it in logs, PRs or issues.

### Git

- One issue, one branch, one PR. Write `Closes #n` in the body. Use squash merge only. Never create a merge commit. Sync with rebase.
- Do **not write any AI attribution or advertising line** in commit messages, PR bodies or issue bodies (for example `Co-Authored-By: …`, "Generated with …").
- Commit only your own changes. Do not touch other people's branches or worktrees.

---

## 5. The process for one issue

```
Read issue + comments ──► Check refinement against code (post fixes as comments) ──► Branch ──► Implement + tests
      ▲                                                                                              │
      │                                                                                              ▼
      │                                                                   Local gate all green + guard-removal mutations all red
      │                                                                                              │
      │                                                                                              ▼
      └──── Revise ◄── Review findings ◄── Two independent reviews ◄── Open PR (CI green, auto-merge off)
                                                  │ pass
                                                  ▼
            needs-owner? ──yes──► Stay in draft; wait for the owner (screenshots, thresholds, copy)
                │ no                                │ confirmed
                ▼                                   ▼
        gh pr merge --auto --squash --match-head-commit <reviewed sha>
                ▼
        ci + deploy succeed on main ──► Post-deploy check (§7) ──► Report
```

- **Local gate**: `npx wrangler types --check`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:ssr`.
- **Guard-removal mutation**: when you delete any guard rule (a condition, a filter, a switch check), at least one test must turn red. If none does, add a test. List the mutations you ran in the PR body.
- **Two reviews**: one from a model family different from the implementer, one that checks "does it meet the issue and the contract". Take the union of the findings. Check each one against the source before you act on it.
- **If the head changes, the review is void**: merge with `--match-head-commit` to bind the merge to the reviewed commit.
- **PR body** states: what you did, where you differ from the refinement or the contract (deviations) and why, and which items are not verified.
- **CI** runs on a self-hosted runner on the owner's WSL host (`runs-on: [self-hosted, wsl]`). Tests must not hard-code ports.
  They must not depend on state outside the working directory. The runner sometimes hangs in `setup-node` for ten minutes or so. The job has `timeout-minutes`. Do not cancel a deployment in the middle of the migration step.

---

## 6. Things the owner must handle

Do not make these decisions for the owner:

- Turning any switch on or off; any call that spends real money.
- What is important and what is noise in a section, thresholds, the source list (the #8 way: draft PR + confirmation checklist).
- Public-site UI changes: before merge, show the owner screenshots at 375px and 1280px, in light and dark mode.
- #12: connect Email Service to `ioenv.com` and confirm the sender address (`digest@ioenv.com` in the contract is an assumption).
- The Web Analytics `CF_BEACON_TOKEN` (now an empty string, so the beacon is not output).
- The billing channel for embed (`@cf/baai/bge-m3`): you need credentials with read access to the AI Gateway log to confirm it (the log id is in a #9 comment).

When you ask, give: the background, the real question, the cost and consequence of each option, and your recommendation with reasons.

---

## 7. Production operations

Load the credentials first (only on the owner's machine; do not echo the contents):

```sh
set -a; . ./.env.prod; set +a
```

Common read-only queries:

```sh
npx wrangler d1 migrations list ainews --remote          # Expect "No migrations to apply!"
npx wrangler d1 execute ainews --remote --json --command \
  "SELECT stage, count(*) n FROM articles GROUP BY stage"
npx wrangler d1 execute ainews --remote --json --command \
  "SELECT slot, status, count(*) n, sum(cost_micros) c FROM llm_calls GROUP BY slot, status"
npx wrangler d1 execute ainews --remote --json --command \
  "SELECT * FROM budgets ORDER BY day DESC LIMIT 3"
npx wrangler d1 execute ainews --remote --json --command \
  "SELECT id, name, status, fail_count, last_error FROM sources"
curl -s -o /dev/null -w '%{http_code}\n' https://news.ioenv.com/
```

**Post-deploy check**: `ci` and `deploy` both succeed on main; the migration is applied; the new tables, columns and indexes exist in production;
the related pages return the correct status codes; no switch value changed by accident. Paste the raw output in the PR or in an issue comment.

**Stop conditions** (if any one occurs, immediately open a PR that changes only `MODEL_CALLS_ENABLED` back to `"false"`, then report):

- The gateway spends more than $0.50 in one hour.
- The same kind of error keeps recurring (for example the number of `failed` rows with the same error in `llm_calls` keeps growing).
- `llm_calls` has a row with `status='unknown'` (the call was sent, the result was not saved, and a person must reconcile the books).

When you turn model calls off, keep `COLLECT_ENABLED` on: new articles stay at `body_ready`, and the catch-up queue processes them after you turn model calls back on.

**Writing production data** (seeds, backfills, recovery SQL): first run a dry-run or check the number of affected rows, show it to the owner, and run it only after the owner confirms. Run it only once.
Paste the counts from before and after.

---

## 8. Known gaps (recorded, not handled)

| Gap                                                                                                                                                                                                                                 | Recorded in |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| When manual SQL resets an analyzed article back to `body_ready`, the same UPDATE must write `analysis_generation = analysis_generation + 1`. Otherwise the unique key `analyses (article_id, prompt_version)` blocks the new result | #81         |
| `corrections` lacks an index on `(target_type, target_id, created_at DESC, id DESC)`; add it when #9 starts writing corrections                                                                                                     | #9 comment  |
| To clear a manual override, write NULL, not an empty string                                                                                                                                                                         | #9 comment  |
| The billing channel for embed is not confirmed                                                                                                                                                                                      | #9 comment  |
| `canonical_url` is globally unique: an article belongs only to the first section that collected it                                                                                                                                  | Contract §9 |
| Architecture test: the starting set of R1 does not include `src/components/**`, and the forbidden set does not include `server/db`; R2 checks only the direct imports of routes                                                     | #34         |
| Jina (tier 3) needs all of these: `THIRD_PARTY_READER_ENABLED`, source `jina_enabled=1`, `MODEL_CALLS_ENABLED`, `JINA_API_KEY`, and a `jina` budget above 0 (now $0)                                                                | Contract §8 |
| `restTransport` returns No route for gateway models; production uses only the binding                                                                                                                                               | #39         |

---

## 9. Common commands and scripts

| Command                                    | Purpose                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                              | Local development; uses production bindings, needs a Cloudflare login                                             |
| `npm test`                                 | vitest: the `workers` project + the `node` project (two time zones: UTC and Asia/Shanghai)                        |
| `npm run test:ssr`                         | Build with `env.test`, then run an SSR smoke test with `vite preview`                                             |
| `npm run db:generate`                      | Generate a migration from `src/server/db/schema/`                                                                 |
| `npm run seed:local` / `seed:remote`       | Section and source seeds; `ON CONFLICT DO NOTHING`, safe to run again                                             |
| `scripts/try-analysis.ts`                  | Run a real Jev analysis on fixture articles; not saved to the DB or the ledger (costs money; `--dry-run` is free) |
| `scripts/probe-write.ts`                   | Probe the write slot with real calls; shows `finishReason` and thinking tokens                                    |
| `scripts/smoke-models.ts`, `smoke-body.ts` | Smoke tests for models and body fetching                                                                          |
| `scripts/provision.sh`                     | Create D1, R2, queues and Vectorize (idempotent)                                                                  |

Node 24 (`.nvmrc`). Run the `.ts` files in `scripts/` with `node --import ./scripts/ts-resolve.mjs`.
