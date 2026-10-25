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
  if (
    lower.includes("cf-turnstile") ||
    lower.includes("challenges.cloudflare.com") ||
    lower.includes("just a moment...") ||
    lower.includes("attention required! | cloudflare") ||
    lower.includes("please enable javascript") ||
    lower.includes("enable javascript to run this app") ||
    lower.includes("you need to enable javascript") ||
    lower.includes("checking your browser before accessing") ||
    lower.includes('id="challenge-running"') ||
    lower.includes('id="cf-please-wait"')
  ) {
    return true;
  }

  // Check specifically within <noscript> blocks to avoid false positives on analytics/GTM
  const noscriptRegex = /<noscript[^>]*>([\s\S]*?)<\/noscript>/gi;
  let match;
  while ((match = noscriptRegex.exec(html)) !== null) {
    const inner = match[1].toLowerCase();
    if (
      inner.includes("javascript") ||
      inner.includes("enable js") ||
      inner.includes("turn on js") ||
      inner.includes("requires js")
    ) {
      return true;
    }
  }

  return false;
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

  const kind = "rss" as const;
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

    // If no RSS anywhere, reject candidate
    if (feedItems.length === 0) {
      return {
        kind: "rss",
        feedUrl: url,
        name: siteName,
        siteDomain,
        fetchRung: 0,
        requiresBrowser: 1,
        sampleArticles: [],
        rejectionReason: "no_rss_feed",
      };
    }
  }

  // 3. Collect up to 3-5 sample articles and check ladder rungs
  const defaultToMarkdown: ToMarkdown = async (bytes, mime) => {
    const decoded = new TextDecoder().decode(bytes);
    if (mime.includes("html") || decoded.includes("<")) {
      const root = parse(decoded);
      for (const s of root.querySelectorAll("script, style, noscript")) {
        s.remove();
      }
      return root.text.trim();
    }
    return decoded.trim();
  };

  const ladderDeps: LadderDeps = {
    fetch: deps.fetch,
    toMarkdown: deps.toMarkdown ?? defaultToMarkdown,
  };

  const sampleArticles: SampleArticle[] = [];
  const rungs: number[] = [];
  const itemsToSample = feedItems.slice(0, 5);

  let rateLimitedCount = 0;
  const siteHost = siteDomain.toLowerCase();
  const cleanSite = siteName.toLowerCase();
  const allowedDomains = [siteDomain, siteName].filter(Boolean);

  for (const item of itemsToSample) {
    let itemUrl: URL;
    try {
      itemUrl = new URL(item.url);
    } catch {
      continue;
    }

    const itemHost = itemUrl.hostname.toLowerCase();
    // Strictly verify itemHost is on siteDomain or subdomains of cleanSite.
    // Never allow parent domain (e.g. siteDomain 'tenant.github.io' must NOT match itemHost 'github.io').
    const isSameSite =
      itemHost === siteHost ||
      itemHost === cleanSite ||
      itemHost.endsWith("." + cleanSite);

    if (!isSameSite) {
      // External/cross-domain link in RSS (e.g. ad, sponsor), do not fetch or accept as Rung 0
      continue;
    }

    // Check if item has full content in feed (Rung 0)
    let rung0Body: string | null = null;
    if (item.contentHtml) {
      const root = parse(item.contentHtml);
      for (const s of root.querySelectorAll("script, style, noscript")) {
        s.remove();
      }
      const cleanText = root.text.trim();
      if (cleanText.length >= MIN_BODY_CHARS) {
        rung0Body = cleanText;
      }
    }

    if (rung0Body && isBody(rung0Body) && !isBrowserRequired(rung0Body)) {
      sampleArticles.push({
        url: item.url,
        title: item.title,
        body: rung0Body,
        summary: item.summary ?? undefined,
      });
      rungs.push(0);
      continue;
    }

    // Robots check for sample article hop
    const robots = await checkRobots(
      env,
      item.url,
      deps.now(),
      deps.fetch,
      allowedDomains,
    );
    if (!robots.allowed) {
      continue;
    }

    // Rate limiting slot claim for sample article host
    const slot = await claimHostSlot(
      env,
      itemUrl.host,
      robots.crawlDelaySec ?? 0,
      deps.now(),
    );
    if (!slot.claimed) {
      rateLimitedCount++;
      continue;
    }

    // Fetch sample article via ladder fetchPage (Rungs 1 & 2)
    const page = await fetchPage(
      env,
      item.url,
      deps.now(),
      allowedDomains,
      ladderDeps,
    );

    if (page.kind === "deferred") {
      // Crawl slot unavailable on redirect hop
      rateLimitedCount++;
      continue;
    }

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
    const isRateLimited = rateLimitedCount > 0;
    return {
      kind,
      feedUrl,
      name: siteName,
      siteDomain,
      fetchRung: 0,
      requiresBrowser: isRateLimited ? 0 : 1,
      sampleArticles: [],
      rejectionReason: isRateLimited
        ? "rate_limited"
        : "insufficient_body_text",
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
