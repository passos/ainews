// Writes the seed SQL to .seed.sql (git-ignored) and runs it with wrangler on
// the local or the remote D1 database. Safe to run again: the SQL only
// inserts what is missing and never overwrites (see src/server/db/seed/sql.ts).
// It opens no switch: sources start active, but COLLECT_ENABLED stays as it is.
//
// Usage (npm run seed:local | npm run seed:remote):
//   node --import ./scripts/ts-resolve.mjs scripts/seed.ts --local|--remote
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Explicit extension: Node resolves this file directly. The files it imports
// have none, so the --import preload is needed (scripts/ts-resolve.mjs).
import { buildSeedSql } from "../src/server/db/seed/sql.ts";

const target = process.argv[2];
if (target !== "--local" && target !== "--remote") {
  console.error("Usage: scripts/seed.ts --local|--remote");
  process.exit(2);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const file = fileURLToPath(new URL("../.seed.sql", import.meta.url));
writeFileSync(file, buildSeedSql() + "\n");
console.log(`wrote ${file}`);

// The D1 database name in wrangler.jsonc.
const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "ainews", target, "--file", file],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
