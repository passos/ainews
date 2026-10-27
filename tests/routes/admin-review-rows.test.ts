// #87 A4: review rows are a two-column grid. The title wraps in the left
// column; the buttons sit top-right and never wrap, whatever the title length.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  PendingRow,
  PublishedList,
  PublishedRow,
} from "../../src/components/admin/ReviewRows";
import { renderInRouter } from "../helpers/render-in-router";

const LONG = "A very long headline ".repeat(30) + "x".repeat(200);
const noop = () => {};

const pending = {
  id: 5,
  industryId: 1,
  industrySlug: "technology",
  industryName: "Technology",
  title: LONG,
  summary: "Summary",
  canonicalUrl: "https://example.com/a",
  url: "https://example.com/a",
  bodySha: "abcdef0123456789",
  score: 7,
  tags: "ai",
  publishedAt: 1,
  fetchedAt: 2,
};
const published = {
  id: 6,
  industryName: "Technology",
  title: LONG,
  bodySha: "sha-6",
  publishedAt: 1_000,
  fetchedAt: 2_000,
};

const GRID = "grid grid-cols-[minmax(0,1fr)_auto]";

function checkRow(out: string) {
  expect(out).toContain(GRID);
  const left = out.match(/<div class="[^"]*min-w-0[^"]*">/)?.[0] ?? "";
  expect(left).toContain("break-words");
  const right = out.match(/<div class="[^"]*self-start[^"]*">/)?.[0] ?? "";
  expect(right).toContain("shrink-0");
  expect(right).toContain("whitespace-nowrap");
  // The long title is inside the left column, before the button group.
  expect(out.indexOf(LONG)).toBeGreaterThan(out.indexOf(left));
  expect(out.indexOf(LONG)).toBeLessThan(out.indexOf(right));
}

describe("review rows", () => {
  it("Pending row: grid, wrapping title, top-right buttons", async () => {
    const out = await renderInRouter(
      createElement(PendingRow, {
        art: pending,
        working: false,
        onDecide: noop,
      }),
    );
    checkRow(out);
    expect(out).toContain("Approve");
    expect(out).toContain("Reject");
  });

  it("Published row: same grid, with the Remove button on the right", async () => {
    const out = await renderInRouter(
      createElement(PublishedRow, {
        art: published,
        working: false,
        onRemove: noop,
      }),
    );
    checkRow(out);
    expect(out).toContain("Remove");
  });
});

describe("/admin/published", () => {
  it("lists every article with a Remove button", async () => {
    const out = await renderInRouter(
      createElement(PublishedList, {
        published: [published, { ...published, id: 7, title: "Second" }],
        workingId: null,
        onRemove: noop,
      }),
    );
    expect(out).toContain("Published (2)");
    expect(out).toContain("Second");
    expect(out.match(/>Remove</g)).toHaveLength(2);
  });
});
