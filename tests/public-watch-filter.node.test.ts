// Public reads of `watches` must carry adminWatchWhere, so a reader watch
// (owner_kind = 'reader') never reaches a public page or feed (#132).
// The table fixes how many reads each file has; every read must be matched
// by one use of adminWatchWhere. A new read (or a new file) needs a new row
// on purpose.
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

const READ = /\bfrom\(watches\)|\bFROM watches\b/g;

const EXPECTED: Record<string, number> = {
  "src/server/publication/watches.ts": 3,
  "src/server/publication/articles.ts": 1,
};

/** Uses of adminWatchWhere, without import declarations and the definition. */
function guardUses(text: string): number {
  const body = text
    .replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["'];?/gm, "")
    .split("\n")
    .filter((line) => !/export const adminWatchWhere\b/.test(line))
    .join("\n");
  return body.match(/\badminWatchWhere\b/g)?.length ?? 0;
}

const files = [...sources("src/server/publication"), ...sources("src/routes")];

it("scans the public code", () => {
  for (const file of Object.keys(EXPECTED)) expect(files).toContain(file);
});

it("each public file reads watches as often as the table says", () => {
  const found: Record<string, number> = {};
  for (const file of files) {
    const n = readFileSync(file, "utf8").match(READ)?.length ?? 0;
    if (n > 0) found[file] = n;
  }
  expect(found).toEqual(EXPECTED);
});

it("every public watches read uses adminWatchWhere", () => {
  const uses: Record<string, number> = {};
  for (const file of Object.keys(EXPECTED)) {
    uses[file] = guardUses(readFileSync(file, "utf8"));
  }
  expect(uses).toEqual(EXPECTED);
});
