// Entries from an HTML list page, by the CSS selectors in the source config.
import { parse, type HTMLElement } from "node-html-parser";
import type { SourceConfig } from "./config";
import type { FeedItem } from "./rss";

type ListConfig = NonNullable<SourceConfig["list"]>;

const textOf = (el: HTMLElement | null | undefined) =>
  el ? el.text.replace(/\s+/g, " ").trim() : "";

export function parseHtmlList(
  html: string,
  pageUrl: string,
  config: ListConfig,
): FeedItem[] {
  const items: FeedItem[] = [];
  for (const el of parse(html).querySelectorAll(config.item)) {
    const link = config.link
      ? el.querySelector(config.link)
      : el.tagName === "A"
        ? el
        : el.querySelector("a[href]");
    const href = link?.getAttribute("href");
    if (!href) continue;
    let url: string;
    try {
      url = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    const title = textOf(config.title ? el.querySelector(config.title) : link);
    const dateEl = el.querySelector(config.date ?? "time");
    const publishedRaw =
      dateEl?.getAttribute(config.dateAttr ?? "datetime") ||
      textOf(dateEl) ||
      null;
    items.push({
      url,
      title,
      summary: null,
      contentHtml: null,
      publishedRaw,
      fields: {},
    });
  }
  return items;
}
