import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchArticleLink } from "../src/components/WatchArticleLink";
import type { WatchHitItem } from "../src/server/publication/watches";

const article: WatchHitItem["articles"][number] = {
  id: 7,
  title: "A title",
  summary: null,
  url: "https://news.example/x",
  sourceName: "Wire",
  publishedAt: null,
};

describe("WatchArticleLink", () => {
  it("links the title to the reader page and keeps the original link", () => {
    const html = renderToStaticMarkup(WatchArticleLink({ article }));
    expect(html).toContain('href="/a/7"');
    expect(html).toContain('href="https://news.example/x"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Read the original at Wire");
    expect(html).not.toContain('target="_blank"');
  });

  it("still links the reader page when the url is null", () => {
    const html = renderToStaticMarkup(
      WatchArticleLink({ article: { ...article, url: null } }),
    );
    expect(html).toContain('href="/a/7"');
    expect(html).not.toContain("Read the original");
    expect(html).not.toContain("https://news.example");
    expect(html).toContain("A title");
  });
});
