import { parse } from "node-html-parser";
import type { PipelineEnv } from "../messages";
import { parseFeed, type FeedItem } from "../collect/rss";
import { checkRobots, claimHostSlot } from "../body/robots";
import {
  fetchPage,
  isBody,
  MIN_BODY_CHARS,
  PAGE_ACCEPT,
  PAGE_TIMEOUT_MS,
  type LadderDeps,
  type ToMarkdown,
} from "../body/ladder";

export interface SampleArticle {
  url: string;
  title: string;
  body: string;
  summary?: string;
}

export interface ProbeResult {
  kind: "rss" | "html";
  feedUrl: string;
  name: string;
  siteDomain: string;
  fetchRung: number;
  requiresBrowser: number; // 0 or 1
  sampleArticles: SampleArticle[];
  rejectionReason?: string;
}

export interface ProbeDeps {
  fetch: typeof fetch;
  toMarkdown?: ToMarkdown;
  now: () => number;
}

/** Check if text or HTML triggers anti-bot or JS challenge wall. */
export function isBrowserRequired(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("cf-turnstile") ||
    lower.includes("challenges.cloudflare.com") ||
    lower.includes("just a moment...") ||
    lower.includes("attention required! | cloudflare") ||
    lower.includes("please enable javascript") ||
    lower.includes("enable javascript to run this app") ||
    lower.includes("you need to enable javascript") ||
    lower.includes("checking your browser before accessing") ||
    lower.includes('id="challenge-running"') ||
    lower.includes('id="cf-please-wait"') ||
    (lower.includes("<noscript>") &&
      (lower.includes("javascript") || lower.includes("enable js")))
  );
}

const COMMON_FEED_PATHS = [
  "/feed",
  "/rss",
  "/feed.xml",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
];

async function fetchRawText(
  url: string,
  fetchFn: typeof fetch,
): Promise<{
  text: string;
  ok: boolean;
  status: number;
  contentType: string;
} | null> {
  try {
    const res = await fetchFn(url, {
      headers: { Accept: PAGE_ACCEPT },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      redirect: "follow",
    });
    const contentType = (res.headers.get("Content-Type") ?? "").toLowerCase();
    const text = await res.text();
    return {
      text,
      ok: res.ok,
      status: res.status,
      contentType,
    };
  } catch {
    return null;
  }
}

export async function probeCandidate(
  url: string,
  env: Pick<PipelineEnv, "DB">,
  deps: ProbeDeps,
): Promise<ProbeResult> {
  const now = deps.now();

  let targetUrl: URL;
  try {
    targetUrl = new URL(url);
  } catch {
    return {
      kind: "html",
      feedUrl: url,
      name: "",
      siteDomain: "",
      fetchRung: 0,
      requiresBrowser: 1,
      sampleArticles: [],
      rejectionReason: "invalid_url",
    };
  }

  const siteDomain = targetUrl.hostname;
  const siteName = siteDomain.replace(/^www\./, "");

  // 1. Robots.txt check on candidate URL
  const robots = await checkRobots(env, url, now, deps.fetch, [siteDomain]);
  if (!robots.allowed) {
    return {
      kind: "html",
      feedUrl: url,
      name: siteName,
      siteDomain,
      fetchRung: 0,
      requiresBrowser: 1,
      sampleArticles: [],
      rejectionReason: "robots_blocked",
    };
  }

  // Claim slot for the site domain
  await claimHostSlot(env, siteDomain, robots.crawlDelaySec ?? 0, now);

  // 2. Fetch target URL
  const initialFetch = await fetchRawText(url, deps.fetch);
  if (!initialFetch || !initialFetch.ok) {
    return {
      kind: "html",
      feedUrl: url,
      name: siteName,
      siteDomain,
      fetchRung: 0,
      requiresBrowser: 1,
      sampleArticles: [],
      rejectionReason: "fetch_failed",
    };
  }

  if (isBrowserRequired(initialFetch.text)) {
    return {
      kind: "html",
      feedUrl: url,
      name: siteName,
      siteDomain,
      fetchRung: 0,
      requiresBrowser: 1,
      sampleArticles: [],
      rejectionReason: "requires_browser",
    };
  }

  let kind: "rss" | "html" = "rss";
  let feedUrl = url;
  let feedItems: FeedItem[];

  // Check if initial fetch itself is RSS / Atom
  try {
    feedItems = parseFeed(initialFetch.text, url);
  } catch {
    feedItems = [];
  }

  // If not RSS, try HTML link tag
  if (feedItems.length === 0) {
    const root = parse(initialFetch.text);
    const titleEl = root.querySelector("title");
    const parsedName = titleEl ? titleEl.text.trim() : siteName;

    const link = root.querySelector(
      'link[type="application/rss+xml"], link[type="application/atom+xml"]',
    );
    const linkHref = link?.getAttribute("href");

    if (linkHref) {
      try {
        const resolvedFeed = new URL(linkHref, url).toString();
        const feedRes = await fetchRawText(resolvedFeed, deps.fetch);
        if (feedRes && feedRes.ok) {
          if (isBrowserRequired(feedRes.text)) {
            return {
              kind: "rss",
              feedUrl: resolvedFeed,
              name: parsedName,
              siteDomain,
              fetchRung: 0,
              requiresBrowser: 1,
              sampleArticles: [],
              rejectionReason: "requires_browser",
            };
          }
          feedItems = parseFeed(feedRes.text, resolvedFeed);
          feedUrl = resolvedFeed;
        }
      } catch {
        feedItems = [];
      }
    }

    // If still no feed, probe common feed endpoints
    if (feedItems.length === 0) {
      for (const path of COMMON_FEED_PATHS) {
        try {
          const tryFeedUrl = new URL(path, targetUrl.origin).toString();
          const feedRes = await fetchRawText(tryFeedUrl, deps.fetch);
          if (feedRes && feedRes.ok && !isBrowserRequired(feedRes.text)) {
            const parsed = parseFeed(feedRes.text, tryFeedUrl);
            if (parsed.length > 0) {
              feedItems = parsed;
              feedUrl = tryFeedUrl;
              break;
            }
          }
        } catch {
          // continue probing
        }
      }
    }

    // If no RSS anywhere, fall back to HTML listing
    if (feedItems.length === 0) {
      kind = "html";
      feedUrl = url;
      // Extract links from HTML
      const links = root.querySelectorAll("a[href]");
      const seen = new Set<string>();
      for (const a of links) {
        const href = a.getAttribute("href");
        if (!href) continue;
        try {
          const articleUrl = new URL(href, url);
          if (
            articleUrl.hostname === siteDomain &&
            articleUrl.pathname.length > 3 &&
            !articleUrl.pathname.endsWith(".css") &&
            !articleUrl.pathname.endsWith(".js") &&
            !seen.has(articleUrl.toString())
          ) {
            seen.add(articleUrl.toString());
            const text = a.text.trim();
            if (text.length > 10) {
              feedItems.push({
                url: articleUrl.toString(),
                title: text,
                summary: null,
                contentHtml: null,
                publishedRaw: null,
                fields: {},
              });
            }
          }
        } catch {
          // ignore invalid link
        }
        if (feedItems.length >= 10) break;
      }
    }
  }

  if (feedItems.length === 0) {
    return {
      kind,
      feedUrl,
      name: siteName,
      siteDomain,
      fetchRung: 0,
      requiresBrowser: 1,
      sampleArticles: [],
      rejectionReason: "no_articles_found",
    };
  }

  // 3. Collect up to 3-5 sample articles and check ladder rungs
  const ladderDeps: LadderDeps = {
    fetch: deps.fetch,
    toMarkdown:
      deps.toMarkdown ?? (async (bytes) => new TextDecoder().decode(bytes)),
  };

  const sampleArticles: SampleArticle[] = [];
  const rungs: number[] = [];
  const itemsToSample = feedItems.slice(0, 5);

  for (const item of itemsToSample) {
    // Check if item has full content in feed (Rung 0)
    if (
      item.contentHtml &&
      item.contentHtml.length >= MIN_BODY_CHARS &&
      !isBrowserRequired(item.contentHtml)
    ) {
      sampleArticles.push({
        url: item.url,
        title: item.title,
        body: item.contentHtml,
        summary: item.summary ?? undefined,
      });
      rungs.push(0);
      continue;
    }

    // Fetch sample article via ladder fetchPage (Rungs 1 & 2)
    const page = await fetchPage(
      env,
      item.url,
      deps.now(),
      [siteDomain],
      ladderDeps,
    );

    if (page.kind === "body" && isBody(page.body.markdown)) {
      if (isBrowserRequired(page.body.markdown)) {
        return {
          kind,
          feedUrl,
          name: siteName,
          siteDomain,
          fetchRung: 0,
          requiresBrowser: 1,
          sampleArticles: [],
          rejectionReason: "requires_browser",
        };
      }
      sampleArticles.push({
        url: item.url,
        title: item.title || page.body.markdown.slice(0, 50),
        body: page.body.markdown,
        summary: item.summary ?? undefined,
      });
      rungs.push(page.body.rung);
    }
  }

  if (sampleArticles.length === 0) {
    return {
      kind,
      feedUrl,
      name: siteName,
      siteDomain,
      fetchRung: 0,
      requiresBrowser: 1,
      sampleArticles: [],
      rejectionReason: "insufficient_body_text",
    };
  }

  const fetchRung = Math.min(...rungs);

  return {
    kind,
    feedUrl,
    name: siteName,
    siteDomain,
    fetchRung,
    requiresBrowser: 0,
    sampleArticles,
  };
}
