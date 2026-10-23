# Personal News

A TanStack Start app on one Cloudflare Worker (`ainews-app`), served at
<https://news.ioenv.com>. The design contract is
[`docs/architecture.md`](docs/architecture.md).

## Requirements

- Node 24 (`.nvmrc`)
- For provision and manual deploy: a Cloudflare login (`npx wrangler login`)
  on the account in `wrangler.jsonc`
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

After the merge the owner runs `npm run seed:remote` once. The script writes
`.seed.sql` (git-ignored) and runs it with `wrangler d1 execute`. It runs
Node with `scripts/ts-resolve.mjs`, a preload that lets Node load the
`src/` files that import each other without a file extension.

`scripts/try-analysis.ts` runs the analysis (Jev only, no database, no ledger)
on the articles in `tests/fixtures/analysis/real/` and prints a table. It
calls the real model and needs `.env.prod`, so it runs only on the owner's
machine. `--dry-run` builds and checks the requests without any call.

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
