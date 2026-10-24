// arXiv "catchup" page (https://arxiv.org/catchup/cs.AI/<date>?abs=True):
// all entries of one announcement day, in three sections. Used only by
// scripts/backfill.ts (#46): the RSS feed has the current day only.
import { parse, type HTMLElement } from "node-html-parser";
import { parseFeedDate } from "../../lib/time";
import { SUMMARY_MAX, type FeedItem } from "./rss";

export interface CatchupPage {
  /** Day of the page from its h1 ("Thu, 22 Oct 2026"), or null. */
  date: string | null;
  items: FeedItem[];
  /** Entries without an /abs/ id, a title, an abstract or a known section. */
  dropped: number;
  /** A section shows fewer entries than it has ("showing 50 of 63"). */
  incomplete: boolean;
}

/** Section heading -> the arxiv:announce_type value of the RSS feed. */
const SECTIONS: [RegExp, string][] = [
  [/^New submissions/i, "new"],
  [/^Cross/i, "cross"],
  // The RSS feed splits these into replace and replace-cross; the source
  // config drops both.
  [/^Replacement/i, "replace"],
];

const H1_DATE = /\bon\s+(\w{3},\s+\d{1,2}\s+\w{3}\s+\d{4})\s*$/;

const textOf = (el: HTMLElement | null): string =>
  (el?.text ?? "").replace(/\s+/g, " ").trim();

/**
 * "+hhmm" / "-hhmm" of New York at `ms`: arXiv's RSS pubDate is midnight
 * there ("Fri, 23 Oct 2026 00:00:00 -0400").
 */
export function newYorkOffset(ms: number): string {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(ms)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /^GMT([+-]\d{2}):(\d{2})$/.exec(name ?? "");
  if (!m) throw new Error(`no New York offset: ${name}`);
  return `${m[1]}${m[2]}`;
}

/** The New York calendar date of `ms`, "YYYY-MM-DD". */
export function newYorkDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

/** "Thu, 22 Oct 2026" -> "Thu, 22 Oct 2026 00:00:00 -0400". */
function pubDate(date: string): string | null {
  const midnightUtc = parseFeedDate(date, "+00:00");
  if (!midnightUtc) return null;
  const noon = midnightUtc.getTime() + 12 * 60 * 60_000;
  return `${date} 00:00:00 ${newYorkOffset(noon)}`;
}

/**
 * Entries as FeedItems of the same shape as the arXiv RSS items: url
 * https://arxiv.org/abs/<id> (no version, as the RSS <link>), summary
 * "arXiv:<id> Announce Type: <type> Abstract: <text>", the RSS pubDate of
 * the day, and fields "arxiv:announce_type" and "category".
 */
export function parseArxivCatchup(html: string, pageUrl: string): CatchupPage {
  const root = parse(html);
  const date = H1_DATE.exec(textOf(root.querySelector("h1")))?.[1] ?? null;
  const publishedRaw = date ? pubDate(date) : null;
  const items: FeedItem[] = [];
  let dropped = 0;
  let incomplete = false;
  for (const dl of root.querySelectorAll("dl")) {
    let type: string | null = null;
    let id: string | null = null;
    for (const el of dl.childNodes) {
      if (!("tagName" in el)) continue;
      const node = el as HTMLElement;
      const tag = node.tagName;
      if (tag === "H3") {
        const heading = textOf(node);
        type = SECTIONS.find(([re]) => re.test(heading))?.[1] ?? null;
        const shown = /showing (\d+) of (\d+)/i.exec(heading);
        if (shown && Number(shown[1]) < Number(shown[2])) incomplete = true;
      } else if (tag === "DT") {
        const href = node
          .querySelector('a[title="Abstract"]')
          ?.getAttribute("href");
        id = /\/abs\/(\S+?)(?:v\d+)?$/.exec(href?.trim() ?? "")?.[1] ?? null;
      } else if (tag === "DD") {
        const title = textOf(node.querySelector(".list-title")).replace(
          /^Title:\s*/,
          "",
        );
        const abstract = textOf(node.querySelector("p.mathjax"));
        if (!type || !id || !title || !abstract) {
          dropped += 1;
        } else {
          const subjects = textOf(node.querySelector(".list-subjects"));
          items.push({
            url: new URL(`/abs/${id}`, pageUrl).toString(),
            title,
            summary:
              `arXiv:${id} Announce Type: ${type} Abstract: ${abstract}`.slice(
                0,
                SUMMARY_MAX,
              ),
            contentHtml: null,
            publishedRaw,
            fields: {
              "arxiv:announce_type": [type],
              category: [...subjects.matchAll(/\(([a-z-]+\.[\w-]+)\)/g)].map(
                (m) => m[1],
              ),
            },
          });
        }
        id = null;
      }
    }
  }
  return { date, items, dropped, incomplete };
}
