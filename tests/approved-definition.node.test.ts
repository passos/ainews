// "Approved" has one definition (approvedArticleWhere in
// src/server/publication/articles.ts). Public code must not write its own.
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

it("only articles.ts mentions the 'approved' decision in public code", () => {
  const files = [
    ...sources("src/routes"),
    ...sources("src/components"),
    ...sources("src/server/publication"),
  ].filter((f) => !f.startsWith("src/routes/admin"));
  const mentions = files.filter((f) =>
    /decision\s*=\s*'approved'|r\.decision/.test(readFileSync(f, "utf8")),
  );
  expect(mentions).toEqual(["src/server/publication/articles.ts"]);
});
