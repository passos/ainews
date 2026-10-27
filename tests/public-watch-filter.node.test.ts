// Reads of `watches` in public and admin code must carry the admin-watch
// guard, so a reader watch (owner_kind = 'reader') never reaches a public
// page, a feed, or an admin hit operation (#132).
// The table fixes how many reads each file has; every read must be matched
// by one use of the guard (adminWatchWhere, ADMIN_WATCH_SQL or
// adminWatchSql(alias)). A new read (or a new file) needs a new row on
// purpose. Comments are removed first, so a guard that was commented out
// does not count.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Removes block comments and line comments (not `//` inside a URL). */
function code(file: string): string {
  return readFileSync(file, "utf8").replace(
    /\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm,
    "$1",
  );
}

const READ =
  /\bfrom\(\s*watches\b|\bFROM\s+watches\b|\bJOIN\s+watches\b|\bschema\.watches\b/gi;

const EXPECTED: Record<string, number> = {
  // getWatchView, getActiveWatchesView, hasActiveWatches.
  "src/server/publication/watches.ts": 3,
  // The home page "watches" strip.
  "src/server/publication/articles.ts": 1,
  // listWatches (FROM watches w), listWatchHits (JOIN watches w),
  // listPendingWatchHits (JOIN watches w), reviewWatchHit (the
  // FROM watches w sub-select). INSERT and UPDATE are writes, not reads.
  "src/server/admin/ops.ts": 4,
};

const GUARD = /\badminWatchWhere\b|\bADMIN_WATCH_SQL\b|\badminWatchSql\(/g;

/** Guard uses, without import declarations and the definitions. */
function guardUses(text: string): number {
  const body = text
    .replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["'];?/gm, "")
    .split("\n")
    .filter(
      (line) =>
        !/export (const|function) (adminWatchWhere|ADMIN_WATCH_SQL|adminWatchSql)\b/.test(
          line,
        ),
    )
    .join("\n");
  return body.match(GUARD)?.length ?? 0;
}

const files = [
  ...sources("src/server/publication"),
  ...sources("src/routes"),
  ...sources("src/server/admin"),
];

it("scans the public and admin code", () => {
  for (const file of Object.keys(EXPECTED)) expect(files).toContain(file);
});

it("each scanned file reads watches as often as the table says", () => {
  const found: Record<string, number> = {};
  for (const file of files) {
    const n = code(file).match(READ)?.length ?? 0;
    if (n > 0) found[file] = n;
  }
  expect(found).toEqual(EXPECTED);
});

it("every scanned watches read uses the admin-watch guard", () => {
  const uses: Record<string, number> = {};
  for (const file of Object.keys(EXPECTED)) {
    uses[file] = guardUses(code(file));
  }
  expect(uses).toEqual(EXPECTED);
});
