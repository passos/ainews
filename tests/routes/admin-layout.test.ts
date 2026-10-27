// #87 A4: the admin layout. Row 1 is brand + identity; row 2 is the nav and
// scrolls sideways instead of wrapping. The word "Newsren" is gone.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { AdminLayoutView } from "../../src/components/admin/AdminLayout";
import { ASK_TITLE } from "../../src/components/admin/labels";
import { renderInRouter } from "../helpers/render-in-router";

const html = () =>
  renderInRouter(
    createElement(AdminLayoutView, { email: "me@example.com" }, "BODY"),
  );

describe("admin layout", () => {
  it("shows Daily Admin and never Newsren", async () => {
    const out = await html();
    expect(out).toContain("Daily Admin");
    expect(out).not.toContain("Newsren");
    expect(ASK_TITLE).not.toContain("Newsren");
    expect(ASK_TITLE).toBe("Ask · admin research desk");
  });

  it("row 1 has the email and a plain View site link to /", async () => {
    const out = await html();
    const header = out.slice(out.indexOf("<header"), out.indexOf("</header>"));
    expect(header).toContain("me@example.com");
    expect(header).toMatch(/<a [^>]*href="\/"[^>]*>View site ↗<\/a>/);
  });

  it("row 2 is its own scrolling nav, Published right after Review", async () => {
    const out = await html();
    const nav = out.match(/<nav [^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(nav).toContain("overflow-x-auto");
    expect(nav).toContain("whitespace-nowrap");
    expect(nav).not.toContain("flex-wrap");
    // The brand and email are not inside the nav.
    expect(nav).not.toContain("Daily Admin");
    expect(nav).not.toContain("me@example.com");
    const labels = [...nav.matchAll(/<a [^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
    expect(labels.slice(0, 3)).toEqual(["Overview", "Review", "Published"]);
    expect(labels).not.toContain("Review Queue");
    expect(nav).toContain('href="/admin/published"');
  });
});
