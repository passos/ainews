# Daily

Daily is an agentic news site. It collects news from approved sources, groups
reports about the same story, and explains each story with evidence that
links back to the exact source text. A human editor approves everything that
goes public.

- Live site: <https://news.ioenv.com>
- Product plan: [`docs/plan/Newsren_Plan.md`](docs/plan/Newsren_Plan.md)
- 3-minute demo script: [`docs/demo.md`](docs/demo.md)
- Architecture overview: [`docs/architecture/architecture-overview.md`](docs/architecture/architecture-overview.md)

It runs as one TanStack Start app on one Cloudflare Worker (`ainews-app`).

## The reader loop

The plan asks for three features first: Story Brief with Ask, News-to-Learning,
and Follow a Topic. Together they make one loop:

```
 discover ──────► understand ──────────► investigate ──────────► follow up
 section pages    Story Brief            Evidence: claims with   Watches: saved
 and daily        Explain for student,   verbatim quotes         questions that fire
 briefings        educator, professional Ask about this story    only on material
                  section products       (answers cite sources)  developments
```

## Features

| Feature                                                                                                                                                                  | Where                                            | Plan     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------- |
| Four sections: Technology, Education, Industry, Finance                                                                                                                  | `/s/<section>`                                   | N§3      |
| Article page with source, publication and retrieval times                                                                                                                | `/a/<id>`                                        | N§6      |
| Story page: one event built from several reports                                                                                                                         | `/e/<id>`                                        | N§2.2    |
| AI Story Brief: what happened, what is new, evidence, what to watch                                                                                                      | `/e/<id>`                                        | N§2.2    |
| Explain for student, educator and professional; glossary; learning material                                                                                              | `/e/<id>`                                        | N§2.3    |
| Evidence: claims linked to verbatim quotes, with labels                                                                                                                  | `/e/<id>`                                        | N§2.5    |
| Ask about this story: answers grounded in approved sources, quotes checked                                                                                               | `/e/<id>`                                        | N§2.1    |
| Timeline: the reports behind a story, in the order they arrived                                                                                                          | `/e/<id>`                                        | N§2.2    |
| Section products: Research Paper Decoder, Education Evidence Checker, Classroom Discussion, Supply-Chain Ripple Map, Industry Impact, Regulation Watch, Finance concepts | `/e/<id>`                                        | N§3, N§4 |
| Follow a Topic: public watches and private reader watches with RSS                                                                                                       | `/w`, `/follow`                                  | N§2.6    |
| Daily briefings and RSS per section                                                                                                                                      | `/digest/<section>/<date>`, `/rss/<section>.xml` | N§3      |
| Editor console: review queue, published articles, sources, ledger, Ask, watches                                                                                          | `/admin`                                         | N§6      |

## Trust and safety

- **Human approval.** Each section is in `review` or `auto` mode. Finance is
  always reviewed, and every Finance page says it is not investment advice.
- **Provenance.** Every item shows its source, publication time and retrieval
  time. Evidence quotes are checked in code against the stored body.
- **Labels.** Model judgements are labelled "model assessment". Public Ask
  answers are labelled "Model answer · not editor-reviewed".
- **Separation.** Public pages cannot import model code; a test enforces it.
- **Cost control.** Every model call goes through one client with a ledger
  and a daily budget cap, checked before the call is sent.

## How it works

```
cron (every 10 min)
  └► Q_INGEST : collect ─► body ─► analyze         (Jev scores, Gemini summary)
  └► Q_GROUP  : group into events                   (Vectorize + Jev)
  └► Q_GENERATE: brief, explanations, products, claims, watches, digests, Ask
                         │
                         ▼
                 editor review ─► public site, RSS
```

- One Worker exports `fetch` (site and `/admin`), `scheduled` (cron) and
  `queue` (pipeline consumers).
- Data: D1 through Drizzle. Article bodies are in R2, one file per version
  (`bodies/{article_id}/{sha256}.md`), never overwritten.
- Fixed steps are code. Fast judgements use Jev; writing and reasoning use
  Gemini 3.8 Flash; embeddings use `@cf/baai/bge-m3`.

Details: [`docs/architecture/architecture-overview.md`](docs/architecture/architecture-overview.md). The
binding implementation contract is [`docs/architecture/architecture.md`](docs/architecture/architecture.md).

## Safety switches

Vars in `wrangler.jsonc`. Only the string `"true"` turns one on. In the `test`
env all of them are `"false"`.

| Var                          | Turns on                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `COLLECT_ENABLED`            | Collection and body fetch                                                              |
| `MODEL_CALLS_ENABLED`        | Every model call (paid)                                                                |
| `THIRD_PARTY_READER_ENABLED` | Jina Reader (rung 3); also needs a per-source flag, `JINA_API_KEY` and a `jina` budget |
| `EMAIL_ENABLED`              | Admin email                                                                            |
| `DISCOVERY_ENABLED`          | AI source discovery                                                                    |
| `READER_WATCH_ENABLED`       | Readers can create private watches on `/follow`                                        |
| `ASK_PUBLIC_ENABLED`         | The "Ask about this story" card on event pages                                         |

## Documents

| File                                                                                       | What it is                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [`docs/plan/Newsren_Plan.md`](docs/plan/Newsren_Plan.md)                                   | Product requirements                                  |
| [`docs/demo.md`](docs/demo.md)                                                             | 3-minute demo script                                  |
| [`docs/architecture/architecture-overview.md`](docs/architecture/architecture-overview.md) | How the system works                                  |
| [`docs/architecture/architecture.md`](docs/architecture/architecture.md)                   | Architecture contract                                 |
| [`docs/design/decisions.md`](docs/design/decisions.md)                                     | Scope and technical decisions the owner confirmed     |
| [`docs/deploy.md`](docs/deploy.md)                                                         | Deployment runbook                                    |
| [`AGENTS.md`](AGENTS.md)                                                                   | Rules and process for coding agents                   |
| Epic [#26](https://github.com/githonllc/ainews/issues/26)                                  | Milestones and their gates; every task is a sub-issue |

## Requirements

- Node 24 (`.nvmrc`)
- For provision and manual deploy: a Cloudflare login (`npx wrangler login`)
  on the account in `wrangler.jsonc`, or `CLOUDFLARE_API_TOKEN` in the
  environment (CI uses the token)

## Local development

```sh
npm install
npm run db:migrate:local   # apply D1 migrations to the local database
npm run seed:local         # sections and sources
npm run dev                # http://localhost:5173
```

Copy `.dev.vars.example` to `.dev.vars`. Without it, `SITE_URL` is the
production origin and every POST under `vite dev` returns 403 (Origin check).

`npm run dev` uses the production bindings. AI, Vectorize and `send_email`
always connect to the Cloudflare account, so dev needs a Cloudflare login.

## Checks

```sh
npx --no-install wrangler types --check
npm run typecheck
npm run lint
npm test          # vitest: `workers` and `node` projects
npm run build
npm run test:ssr  # builds with the `test` env, then smoke-tests SSR
```

Tests use the `test` env in `wrangler.jsonc`. It has no AI, Vectorize or
`send_email` binding, so these commands need no Cloudflare credentials and
never call real services.

## Database

```sh
npm run db:generate        # write a new SQL migration from src/server/db/schema/
npm run db:migrate:local   # apply migrations locally
npx wrangler d1 migrations apply DB --remote   # apply to production
```

Migrations live in `drizzle/migrations/` and run through wrangler. They only
add columns or indexes; tables that other tables reference are never rebuilt.

`npm run seed:remote` seeds production. Every statement is
`INSERT … ON CONFLICT DO NOTHING`, so it never overwrites admin changes and
turns on no switch.

## Provision and deploy

```sh
bash scripts/provision.sh     # D1, R2, queues, Vectorize; safe to run again
bash scripts/github-setup.sh  # squash merge only, `main` ruleset with required `ci`
```

A merge to `main` runs CI, applies remote migrations and runs
`npm run deploy`. It needs the repository secret `CLOUDFLARE_API_TOKEN`. See
[the deployment runbook](docs/deploy.md) for manual deploy and rollback.
