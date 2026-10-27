// #87 A4: the sources table (no wrapping except Name / URL), the Delete button
// that is disabled for sources with articles, and the in-page delete dialog.
// There is no jsdom here, so showModal() and the click flow are not run.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  DeleteSourceDialog,
  SourceDeleteButton,
  SourcesTable,
} from "../../src/components/admin/SourcesTable";
import { renderInRouter } from "../helpers/render-in-router";

const noop = () => {};
const row = (id: number, articleCount: number) => ({
  id,
  industryId: 1,
  name: `Source ${id}`,
  feedUrl: "https://example.com/a/very/long/feed/url/that/may/wrap.xml",
  kind: "rss",
  status: "active",
  pausedReason: null,
  fetchRung: 0,
  failCount: 0,
  lastOkAt: 0,
  jinaEnabled: 0,
  articleCount,
});

describe("SourceDeleteButton", () => {
  it("is never disabled because the source has articles", async () => {
    const out = await renderInRouter(
      createElement(SourceDeleteButton, { working: false, onClick: noop }),
    );
    expect(out).not.toContain("disabled");
    expect(out).not.toContain("title=");
    expect(out).toContain(">Delete<");
  });
});

describe("SourcesTable", () => {
  const render = () =>
    renderInRouter(
      createElement(SourcesTable, {
        sources: [row(1, 0), row(2, 4)],
        industries: [{ id: 1, name: "Technology" }],
        actingId: null,
        onResume: noop,
        onTrigger: noop,
        onDelete: noop,
      }),
    );

  it("scrolls sideways and never wraps header or cells", async () => {
    const out = await render();
    expect(out).toMatch(/<div class="[^"]*overflow-x-auto/);
    const table = out.match(/<table [^>]*>/)?.[0] ?? "";
    expect(table).toContain("[&amp;_th]:whitespace-nowrap");
    expect(table).toContain("[&amp;_td]:whitespace-nowrap");
  });

  it("lets only Name and URL wrap; the URL breaks anywhere", async () => {
    const out = await render();
    expect(out).toMatch(
      /<div class="[^"]*whitespace-normal[^"]*">Source 1<\/div>/,
    );
    const url = out.match(/<div class="([^"]*)">https:\/\/example.com/)?.[1];
    expect(url).toContain("break-all");
    expect(url).toContain("whitespace-normal");
    expect(out).not.toContain("truncate");
  });

  it("keeps Delete enabled for a source with articles", async () => {
    const out = await render();
    expect(out).not.toContain("disabled");
    expect(out.match(/>Delete</g)).toHaveLength(2);
  });
});

describe("DeleteSourceDialog", () => {
  const render = (
    error: string | null,
    target = { id: 9, name: "Wire", articleCount: 3 },
  ) =>
    renderInRouter(
      createElement(DeleteSourceDialog, {
        target,
        error,
        working: false,
        onCancel: noop,
        onConfirm: noop,
      }),
    );

  it("asks by id and name with Cancel and Delete, and no window.confirm", async () => {
    const out = await render(null);
    expect(out).toContain("<dialog");
    expect(out).toContain("Delete source #9 Wire?");
    expect(out).toContain(
      "Its 3 articles stay on the site; the source stops being collected.",
    );
    expect(out).toContain(">Cancel<");
    expect(out).toContain(">Delete<");
  });

  it("shows a server error inside the dialog", async () => {
    const out = await render("Source not found or not deletable");
    const dialog = out.slice(out.indexOf("<dialog"), out.indexOf("</dialog>"));
    expect(dialog).toContain("Source not found or not deletable");
    expect(dialog).toContain('role="alert"');
  });
});
