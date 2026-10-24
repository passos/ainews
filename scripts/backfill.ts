// One-off backfill of the last N days of arXiv cs.AI (catchup pages) and
// MIT Technology Review (feed pages) (#46). Entries are stored by
// storeItems, as by the cron, which also sends their `body` messages.
//
// Usage:
//   node --import ./scripts/ts-resolve.mjs scripts/backfill.ts \
//     [--dry-run | --apply] [--days N] [--remote]
//
// --dry-run (default): requests the pages, prints per source the counts,
//   the date range and 3 sample titles. Only SELECTs reach the database.
// --apply: also stores the entries. A second run inserts 0.
// --days: the window, default 3 (entries older than now - N days are
//   dropped).
// --remote: the production D1, R2 and queue (remote bindings; needs the
//   wrangler login). Default: the local D1 of this checkout
//   (`npm run db:migrate:local`, `npm run seed:local`).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPlatformProxy, unstable_readConfig } from "wrangler";
import {
  backfillArxiv,
  backfillFeedPages,
  loadSource,
  parseBackfillArgs,
  type BackfillReport,
} from "../src/pipeline/collect/backfill.ts";
import { SEED_SOURCES } from "../src/server/db/seed/sources.ts";

let args: ReturnType<typeof parseBackfillArgs>;
try {
  args = parseBackfillArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_PATH = fileURLToPath(
  new URL("../wrangler.jsonc", import.meta.url),
);
// Only the three bindings storeItems uses, from the top level of
// wrangler.jsonc, `remote` as asked. Written under .wrangler/ (git-ignored).
const GENERATED = `${ROOT}.wrangler/backfill.wrangler.json`;

function writeConfig(remote: boolean): void {
  const base = unstable_readConfig({ config: CONFIG_PATH });
  const d1 = base.d1_databases.find(
    (b: { binding: string }) => b.binding === "DB",
  );
  const r2 = base.r2_buckets.find(
    (b: { binding: string }) => b.binding === "BODIES",
  );
  const queue = base.queues.producers?.find(
    (b: { binding: string }) => b.binding === "Q_INGEST",
  );
  if (!d1 || !r2 || !queue) throw new Error("wrangler.jsonc: binding missing");
  const config = {
    name: "ainews-backfill",
    account_id: base.account_id,
    compatibility_date: base.compatibility_date,
    d1_databases: [
      {
        binding: "DB",
        database_name: d1.database_name,
        database_id: d1.database_id,
        remote,
      },
    ],
    r2_buckets: [{ binding: "BODIES", bucket_name: r2.bucket_name, remote }],
    queues: {
      producers: [{ binding: "Q_INGEST", queue: queue.queue, remote }],
    },
  };
  mkdirSync(`${ROOT}.wrangler`, { recursive: true });
  writeFileSync(GENERATED, JSON.stringify(config, null, 2) + "\n");
}

const iso = (ms: number | null) =>
  ms === null ? "-" : new Date(ms).toISOString();

function print(name: string, feedUrl: string, r: BackfillReport): void {
  console.log(`\n[source ${r.sourceId}] ${name} (${feedUrl})`);
  for (const page of r.pages) console.log(`  page ${page}`);
  console.log(
    `  entries ${r.fetched}, unreadable ${r.dropped}, excluded by config ${r.excluded}, older than window ${r.stale}, kept ${r.kept}`,
  );
  console.log(`  published_at ${iso(r.oldest)} .. ${iso(r.newest)}`);
  console.log(`  already stored ${r.existing}, new ${r.fresh}`);
  for (const title of r.samples) console.log(`  sample: ${title}`);
  console.log(
    r.inserted === null
      ? "  dry run: nothing written"
      : `  inserted ${r.inserted} (body messages sent for them)`,
  );
}

const RUNS = [
  { name: "arXiv cs.AI", run: backfillArxiv },
  { name: "MIT Technology Review", run: backfillFeedPages },
];

const now = Date.now();
console.log(
  `${args.apply ? "APPLY" : "DRY RUN"}, ${args.remote ? "REMOTE (production)" : "local"} database, window ${args.days} days from ${iso(now)}`,
);
writeConfig(args.remote);
const proxy = await getPlatformProxy<Pick<Env, "DB" | "BODIES" | "Q_INGEST">>({
  configPath: GENERATED,
  // No .env file: the remote run uses the wrangler login.
  envFiles: [],
  persist: { path: `${ROOT}.wrangler/state/v3` },
  remoteBindings: args.remote,
});
let failed = false;
try {
  for (const { name, run } of RUNS) {
    const seed = SEED_SOURCES.find((s) => s.name === name);
    const source = seed ? await loadSource(proxy.env.DB, seed.feedUrl) : null;
    if (!seed || !source) {
      console.error(`\n${name}: no active source row`);
      failed = true;
      continue;
    }
    try {
      const report = await run(
        proxy.env,
        source,
        { apply: args.apply, days: args.days, now },
        {
          fetch,
          sleep: (ms) => {
            console.log(`  waiting ${ms / 1000} s`);
            return new Promise((resolve) => setTimeout(resolve, ms));
          },
        },
      );
      print(name, seed.feedUrl, report);
    } catch (error) {
      console.error(
        `\n${name}: ${error instanceof Error ? error.message : error}`,
      );
      failed = true;
    }
  }
} finally {
  await proxy.dispose();
}
process.exit(failed ? 1 : 0);
