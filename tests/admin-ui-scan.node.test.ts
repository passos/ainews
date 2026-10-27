import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #87 A4: source-level guards for the admin pages. They read the files because
// a page cannot be rendered without its loader.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const adminFiles = [
  ...walk("src/routes/admin"),
  ...walk("src/components/admin"),
].filter((f) => f.endsWith(".tsx"));
const read = (f: string) => readFileSync(f, "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("admin pages", () => {
  it("do not show 'Newsren' (comments aside)", () => {
    const hits = adminFiles.filter((f) =>
      stripComments(read(f)).includes("Newsren"),
    );
    expect(hits).toEqual([]);
  });

  it("wrap every table in overflow-x-auto and use the no-wrap table class", () => {
    const tableFiles = adminFiles.filter((f) => read(f).includes("<table"));
    // The routes with a table today; a new one must join the rule.
    expect(tableFiles.length).toBeGreaterThanOrEqual(8);
    for (const f of tableFiles) {
      const src = read(f);
      const tables = src.match(/<table\b[^>]*>/g) ?? [];
      for (const t of tables) {
        expect(t, f).toContain("ADMIN_TABLE");
      }
      const wraps = src.match(/overflow-x-auto|ADMIN_TABLE_WRAP/g) ?? [];
      expect(wraps.length, f).toBeGreaterThanOrEqual(tables.length);
      expect(src, f).not.toContain("overflow-hidden");
    }
  });

  it("keep the Published list out of the review page", () => {
    const review = read("src/routes/admin/review.tsx");
    expect(review).not.toContain("listPublishedArticles");
    expect(review).not.toContain("RemoveButton");
    const published = read("src/routes/admin/published.tsx");
    expect(published).toContain('createFileRoute("/admin/published")');
    expect(published).toContain("listPublishedArticles");
    expect(published).toContain("PublishedList");
    expect(read("src/components/admin/ReviewRows.tsx")).toContain(
      "RemoveButton",
    );
    expect(read("src/routeTree.gen.ts")).toContain("'/admin/published'");
  });

  it("do not use window.confirm for source delete", () => {
    expect(read("src/routes/admin/sources/index.tsx")).not.toMatch(
      /\bconfirm\(/,
    );
  });
});
