// "Approved" has one definition: APPROVED_ARTICLE_SQL in
// src/server/publication/articles.ts (approvedArticleWhere is built from it).
// Public code and pipeline code must not write their own copy (#84).
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

const APPROVED = /decision\s*=\s*'approved'|r\.decision/g;

/**
 * The only places where the approved condition may be written out. Each
 * entry is one named constant; the scan removes the constant's template text
 * and then requires zero matches in what is left of every file.
 */
const WHITELIST: { file: string; constant: string; reason: string }[] = [
  {
    file: "src/server/publication/articles.ts",
    constant: "APPROVED_ARTICLE_SQL",
    reason: "the definition itself",
  },
  {
    file: "src/server/publication/articles.ts",
    constant: "CARD_COLUMNS",
    reason:
      "event_report_count needs aliases a2/r2, and APPROVED_ARTICLE_SQL is fixed to a/r. Kept as a non-goal of #84.",
  },
  {
    file: "src/server/publication/articles.ts",
    constant: "APPROVED_BY_SQL",
    reason:
      "reader page: returns the approving review's reviewer, which an EXISTS cannot. Same condition as APPROVED_ARTICLE_SQL.",
  },
  {
    file: "src/pipeline/evidence/primary.ts",
    constant: "ANY_BODY_APPROVED_SQL",
    reason:
      "primary tracker recovery path: approved at ANY body version, not the current one. Different meaning on purpose; see #84.",
  },
];

/** Template text of `const NAME = \`...\`` or `const NAME: T = sql\`...\``. */
function constantBody(text: string, name: string): string | null {
  const m = new RegExp(
    `(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*(?:sql)?\`([^\`]*)\``,
  ).exec(text);
  return m ? m[0] : null;
}

function count(text: string): number {
  return text.match(APPROVED)?.length ?? 0;
}

/** Matches left in each file after the whitelisted constants are removed. */
function inlineCopies(files: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of files) {
    let text = readFileSync(file, "utf8");
    for (const w of WHITELIST.filter((w) => w.file === file)) {
      const body = constantBody(text, w.constant);
      if (body) text = text.replace(body, "");
    }
    const n = count(text);
    if (n > 0) out[file] = n;
  }
  return out;
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

it("each whitelisted constant exists and holds exactly one approved condition", () => {
  const found = WHITELIST.map((w) => {
    const body = constantBody(readFileSync(w.file, "utf8"), w.constant);
    return {
      constant: w.constant,
      matches: body === null ? null : count(body),
    };
  });
  expect(found).toEqual(
    WHITELIST.map((w) => ({ constant: w.constant, matches: 1 })),
  );
});

it("pipeline has no inline copy of the approved condition", () => {
  const files = sources("src/pipeline");
  // Guard against an empty walk passing by accident.
  expect(files).toContain("src/pipeline/digest/build.ts");
  expect(inlineCopies(files)).toEqual({});
});

it("public code has no copy outside the whitelisted constants", () => {
  const files = [
    ...sources("src/routes"),
    ...sources("src/components"),
    ...sources("src/server/publication"),
  ].filter((f) => !f.startsWith("src/routes/admin"));
  expect(files).toContain("src/server/publication/articles.ts");
  expect(inlineCopies(files)).toEqual({});
});

// How often each pipeline file interpolates the shared condition. The scan
// above stops copies from coming back; this stops the condition from being
// deleted: a file that drops one use no longer matches its count. A new use
// (or a new file) needs a new row on purpose.
const EXPECTED_USES: Record<string, number> = {
  "src/pipeline/artifacts/build.ts": 2,
  "src/pipeline/ask/answer.ts": 1,
  "src/pipeline/digest/build.ts": 15,
  "src/pipeline/due-events.ts": 1,
  "src/pipeline/evidence/build.ts": 1,
  "src/pipeline/evidence/diff.ts": 2,
  "src/pipeline/evidence/primary.ts": 4,
  "src/pipeline/group/group-article.ts": 3,
  "src/pipeline/watch/evaluate.ts": 1,
};

it("each pipeline file uses the shared approved condition as often as expected", () => {
  const found: Record<string, number> = {};
  for (const file of sources("src/pipeline")) {
    const n =
      readFileSync(file, "utf8").match(
        /\$\{(?:APPROVED_ARTICLE_SQL|approvedArticleWhere)\}/g,
      )?.length ?? 0;
    if (n > 0) found[file] = n;
  }
  expect(found).toEqual(EXPECTED_USES);
});

it("ANY_BODY_APPROVED_SQL is interpolated once, in the primary tracker", () => {
  // It accepts an approval of any body version; a reader-facing query must
  // not pick it up by accident.
  const found: Record<string, number> = {};
  for (const file of sources("src")) {
    const n =
      readFileSync(file, "utf8").match(/\$\{ANY_BODY_APPROVED_SQL\}/g)
        ?.length ?? 0;
    if (n > 0) found[file] = n;
  }
  expect(found).toEqual({ "src/pipeline/evidence/primary.ts": 1 });
});

it("admin routes do not compare a review decision to approved (#102)", () => {
  // Admin pages use isApprovedReview from src/lib/approved-review.ts. No
  // whitelist here: the helper lives in src/lib, outside src/routes.
  const files = sources("src/routes/admin");
  expect(files).toContain("src/routes/admin/articles/$articleId.tsx");
  const copies = files.filter((f) =>
    /decision\s*[!=]==?\s*["\x27`]approved["\x27`]/.test(
      readFileSync(f, "utf8"),
    ),
  );
  expect(copies).toEqual([]);
});
