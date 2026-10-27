// #87 A4: /admin/** has its own header. The root layout must not draw the
// public section nav or footer there, and must still draw them elsewhere.
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { RootLayoutView, isAdminPath } from "../../src/routes/__root";
import { renderInRouter } from "../helpers/render-in-router";

const shell = {
  name: "Daily",
  sections: [
    { slug: "technology", name: "Technology" },
    { slug: "education", name: "Education" },
    { slug: "industry", name: "Industry" },
    { slug: "finance", name: "Finance" },
  ],
  hasWatches: true,
  readerWatchEnabled: true,
};

const render = (isAdmin: boolean) =>
  renderInRouter(createElement(RootLayoutView, { isAdmin, shell }, "CONTENT"));

describe("isAdminPath", () => {
  it("matches /admin and /admin/... only", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/review")).toBe(true);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isAdminPath("/")).toBe(false);
    expect(isAdminPath("/s/technology")).toBe(false);
  });
});

describe("root layout", () => {
  it("under /admin renders no public nav, header or footer", async () => {
    const out = await render(true);
    expect(out).toContain("CONTENT");
    for (const label of [
      "Technology",
      "Education",
      "Industry",
      "Finance",
      "Watches",
    ]) {
      expect(out).not.toContain(label);
    }
    expect(out).not.toContain("<footer");
    expect(out).not.toContain("<header");
  });

  it("on the public site still renders the section nav and footer", async () => {
    const out = await render(false);
    expect(out).toContain("CONTENT");
    for (const label of ["Technology", "Education", "Industry", "Finance"]) {
      expect(out).toContain(label);
    }
    expect(out).toContain("<footer");
  });
});
