# Personal News

A news site that finds hot topics and writes daily reports by itself. One
admin, several sections (Technology, Education, Industry, Finance). It is a
TanStack Start app on one Cloudflare Worker (`ainews-app`), served at
<https://news.ioenv.com>.

**Coding agents: read [`AGENTS.md`](AGENTS.md) first.** It has the current
state, the remaining work, the rules a PR must not break, and the process.

## Documents

| File                                                      | What it is                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| [`docs/Newsren_Plan.md`](docs/Newsren_Plan.md)            | Product requirements. They must be met.                     |
| [`docs/design/decisions.md`](docs/design/decisions.md)    | Scope and technical decisions the owner confirmed           |
| [`docs/architecture.md`](docs/architecture.md)            | Architecture contract. Every issue follows it.              |
| [`AGENTS.md`](AGENTS.md)                                  | Handover guide for coding agents                            |
| Epic [#26](https://github.com/githonllc/ainews/issues/26) | Milestones M0–M4 and their gates; every task is a sub-issue |

## How it works

```
cron (every 10 min) ─► Q_INGEST: collect ─► body ─► analyze ─► (review) ─► public site, RSS
                                   │          │         │
                                RSS/HTML   fetch      Jev: prefilter, scores, labels
                                dedupe     ladder     Gemini: title and summary
```

- One Worker exports `fetch` (site and `/admin`), `scheduled` (cron) and
  `queue` (pipeline consumers).
- Data: D1 through Drizzle. Article bodies are in R2 as versions
  (`bodies/{article_id}/{sha256}.md`) that are never overwritten.
- Every model call goes through one client with a call ledger (`llm_calls`)
  and a daily budget per channel, in integer micro-USD.
- Fixed steps are deterministic code. Fast judgements use Jev; writing uses
  Gemini 3.8 Flash; reasoning uses Claude Sonnet 5.5.
- The public site shows only approved articles. Every section starts in review
  mode; Finance is always reviewed.

## Status

M0 is done. M1 is in progress: collection, body fetch, analysis, the seed
sections and the public site are live. The admin review queue (#9), event
grouping (#11) and the daily report (#12) are next. See `AGENTS.md` §2–§3.

## Safety switches

Five vars in `wrangler.jsonc`. Only the string `"true"` turns one on.

| Var                          | Turns on                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COLLECT_ENABLED`            | Collection and body fetch                                                                                                                          |
| `MODEL_CALLS_ENABLED`        | Every model call (paid)                                                                                                                            |
| `THIRD_PARTY_READER_ENABLED` | Jina Reader (rung 3). It also needs `jina_enabled = 1` on the source, `JINA_API_KEY`, `MODEL_CALLS_ENABLED`, and a `jina` budget above 0 (now $0). |
| `EMAIL_ENABLED`              | Admin email                                                                                                                                        |
| `DISCOVERY_ENABLED`          | AI source discovery                                                                                                                                |

A switch changes only in its own PR, with the owner's consent. In `env.test`
all five stay `"false"`.

## Requirements

- Node 24 (`.nvmrc`)
- For provision and manual deploy: a Cloudflare login (`npx wrangler login`)
  on the account in `wrangler.jsonc`, or `CLOUDFLARE_API_TOKEN` in the
  environment (CI uses the token)
- For repository setup: `gh` with admin rights on `githonllc/ainews`

## Local development

```sh
npm install
npm run db:migrate:local   # apply D1 migrations to the local database
npm run dev                # http://localhost:5173
```

Copy `.dev.vars.example` to `.dev.vars`. Without it, `SITE_URL` is the
production origin and every POST under `vite dev` returns 403 (Origin check).

`npm run dev` uses the production bindings. AI, Vectorize and `send_email`
always connect to the Cloudflare account, so dev needs a Cloudflare login.

## Checks

```sh
npm run typecheck
npm run lint
npm test          # vitest: `workers` and `node` projects
npm run build
npm run test:ssr  # builds with the `test` env, then smoke-tests SSR with vite preview
```

Tests and `test:ssr` use the `test` env in `wrangler.jsonc`. It has no AI,
Vectorize or `send_email` binding, so these commands need no Cloudflare
credentials and never call real services.

## Database

```sh
npm run db:generate        # write a new SQL migration from src/server/db/schema/
npm run db:migrate:local   # apply migrations locally
npx wrangler d1 migrations apply DB --remote   # apply to production
```

Migrations live in `drizzle/migrations/` and run through wrangler, not Drizzle.

### Seed

```sh
npm run seed:local    # local D1
npm run seed:remote   # production D1
```

Inserts the four sections (Technology, Education, Industry, Finance with
their criteria, thresholds and `primary_domains`) and the two Technology
sources. Every statement is `INSERT … ON CONFLICT DO NOTHING`, so the seed can
run again and never overwrites what the admin changed. It does not turn on any
switch (`COLLECT_ENABLED` and the others stay as they are). It is not part of
the deploy: a deleted seed source would come back with every deploy.

Production was seeded once on 2026-10-23. The script writes
`.seed.sql` (git-ignored) and runs it with `wrangler d1 execute`. It runs
Node with `scripts/ts-resolve.mjs`, a preload that lets Node load the
`src/` files that import each other without a file extension.

`scripts/try-analysis.ts` runs the analysis (Jev only, no database, no ledger)
on the articles in `tests/fixtures/analysis/real/` and prints a table. It
calls the real model and needs `.env.prod`, so it runs only on the owner's
machine. `--dry-run` builds and checks the requests without any call.

`scripts/probe-write.ts` sends a few real requests to the `write` slot and
prints `finishReason` and the thinking token count. Use it before you change
the thinking setting or the output limit of a writing call.

## Provision Cloudflare resources

```sh
bash scripts/provision.sh
```

Creates the D1 database, R2 bucket, queues and Vectorize indexes when they do
not exist. Safe to run again. Put the printed `database_id` into
the top-level `d1_databases` entry of `wrangler.jsonc`. The `test` env keeps
its placeholder id; it only runs locally.

## Deploy

Merges to `main` deploy automatically: the `deploy` job in
`.github/workflows/ci.yml` runs after `ci` passes. It applies remote migrations
and runs `npm run deploy`. It needs the repository secret
`CLOUDFLARE_API_TOKEN`.

Manual deploy:

```sh
npx wrangler d1 migrations apply DB --remote
npm run deploy
```

Secrets are set with `npx wrangler secret put <NAME>`. `.env.example` lists all
variable and secret names.

## Repository setup

```sh
bash scripts/github-setup.sh
```

Allows squash merge only, turns on auto-merge and branch deletion after merge,
and creates or updates the `main` ruleset (`scripts/github/ruleset-main.json`):
the `ci` check must pass, and direct pushes, force pushes and deletion are
blocked. Run it after `ci` has reported on a PR at least once.
