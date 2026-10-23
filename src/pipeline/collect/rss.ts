// RSS 2.0, RSS 1.0 (RDF) and Atom.
import { XMLParser } from "fast-xml-parser";
import { parse } from "node-html-parser";

export interface FeedItem {
  /** Absolute URL as the source wrote it (not normalized). */
  url: string;
  title: string;
  /** Plain text, at most SUMMARY_MAX characters. */
  summary: string | null;
  /** content:encoded (RSS) or content (Atom), unchanged. */
  contentHtml: string | null;
  publishedRaw: string | null;
  /** Text of each child element, by tag name ("category", "arxiv:announce_type"). */
  fields: Record<string, string[]>;
}

/**
 * arXiv abstracts are up to ~1,920 characters after an
 * "arXiv:ID Announce Type: ... Abstract:" prefix; #6 and #8 use the whole
 * summary as the body, so the limit leaves room for it.
 */
export const SUMMARY_MAX = 4000;

type Node = Record<string, unknown>;

/** Text of an HTML fragment: tags removed, entities decoded, spaces joined. */
function htmlToText(html: string): string {
  return parse(html).text.replace(/\s+/g, " ").trim();
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

const list = (value: unknown): unknown[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object" && "#text" in value) {
    return text((value as Node)["#text"]);
  }
  return "";
}

const first = (node: Node, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = text(list(node[key])[0]).trim();
    if (value) return value;
  }
  return null;
};

function atomLink(node: Node): string | null {
  for (const link of list(node.link)) {
    if (typeof link === "string") return link;
    const l = link as Node;
    const rel = l["@_rel"];
    if ((rel === undefined || rel === "alternate") && l["@_href"]) {
      return String(l["@_href"]);
    }
  }
  return null;
}

function fieldsOf(node: Node): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text") continue;
    fields[key] = list(value).map((v) => text(v).trim());
  }
  return fields;
}

function toItem(node: Node, feedUrl: string, atom: boolean): FeedItem | null {
  const rawLink = atom
    ? atomLink(node)
    : (first(node, "link") ??
      (text((list(node.guid)[0] as Node | undefined)?.["@_isPermaLink"]) ===
      "false"
        ? null
        : first(node, "guid")));
  if (!rawLink) return null;
  let url: string;
  try {
    url = new URL(rawLink, feedUrl).toString();
  } catch {
    return null;
  }
  const summary = first(node, "description", "summary");
  return {
    url,
    title: htmlToText(first(node, "title") ?? ""),
    summary: summary ? htmlToText(summary).slice(0, SUMMARY_MAX) : null,
    contentHtml: first(node, "content:encoded", ...(atom ? ["content"] : [])),
    publishedRaw: first(node, "pubDate", "dc:date", "published", "updated"),
    fields: fieldsOf(node),
  };
}

/** Throws if `xml` is not RSS, RDF or Atom. */
export function parseFeed(xml: string, feedUrl: string): FeedItem[] {
  const doc = parser.parse(xml) as Node;
  const rss = doc.rss as Node | undefined;
  const rdf = doc["rdf:RDF"] as Node | undefined;
  const feed = doc.feed as Node | undefined;
  let nodes: unknown[];
  if (rss) nodes = list((rss.channel as Node | undefined)?.item);
  else if (rdf) nodes = list(rdf.item);
  else if (feed) nodes = list(feed.entry);
  else throw new Error("not an RSS, RDF or Atom document");
  const items: FeedItem[] = [];
  for (const node of nodes) {
    const item = toItem(node as Node, feedUrl, Boolean(feed));
    if (item) items.push(item);
  }
  return items;
}
