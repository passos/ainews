// Seed sources (#8, #90). Every section has at least one; the owner decides
// which sources a section watches (AGENTS.md). The `exclude` rules are drafts
// that wait for the owner's answers to gate questions (b) and (c).
import type { ContentDisplay } from "../../../lib/content-display";
import type { SourceConfig } from "../../../pipeline/collect/config";

export interface SeedSource {
  /** Slug of the industry the source belongs to. */
  industry: string;
  name: string;
  kind: "rss" | "html";
  feedUrl: string;
  /** Host of the articles (not of the feed). #6 fetches bodies only if set. */
  siteDomain: string;
  config: SourceConfig;
  /** Reader page display (#86). The owner set every source to full (#154). */
  contentDisplay: ContentDisplay;
}

export const SEED_SOURCES: SeedSource[] = [
  {
    industry: "technology",
    name: "arXiv cs.AI",
    kind: "rss",
    feedUrl: "https://rss.arxiv.org/rss/cs.AI",
    siteDomain: "arxiv.org",
    // arXiv metadata, abstracts included, is CC0.
    contentDisplay: "full",
    config: {
      // The feed summary is the whole abstract: no abs page fetch (the
      // robots.txt of arxiv.org asks for Crawl-delay 15).
      summaryIsBody: true,
      exclude: [
        { field: "arxiv:announce_type", values: ["replace", "replace-cross"] },
      ],
    },
  },
  {
    industry: "technology",
    name: "MIT Technology Review",
    kind: "rss",
    feedUrl:
      "https://www.technologyreview.com/topic/artificial-intelligence/feed/",
    siteDomain: "technologyreview.com",
    contentDisplay: "full",
    config: { exclude: [{ field: "category", values: ["sponsored"] }] },
  },
  {
    industry: "education",
    name: "The Hechinger Report",
    kind: "rss",
    feedUrl: "https://hechingerreport.org/feed/",
    siteDomain: "hechingerreport.org",
    contentDisplay: "full",
    config: {},
  },
  {
    industry: "education",
    name: "EdSurge",
    kind: "rss",
    feedUrl: "https://www.edsurge.com/articles_rss",
    siteDomain: "edsurge.com",
    contentDisplay: "full",
    config: {},
  },
  {
    industry: "industry",
    name: "Semiconductor Engineering",
    kind: "rss",
    feedUrl: "https://semiengineering.com/feed/",
    siteDomain: "semiengineering.com",
    contentDisplay: "full",
    config: {},
  },
  {
    industry: "industry",
    name: "Supply Chain Dive",
    kind: "rss",
    feedUrl: "https://www.supplychaindive.com/feeds/news/",
    siteDomain: "supplychaindive.com",
    // robots.txt asks for Crawl-delay 5.
    contentDisplay: "full",
    config: {},
  },
  {
    industry: "finance",
    name: "SEC press releases",
    kind: "rss",
    feedUrl: "https://www.sec.gov/news/pressreleases.rss",
    siteDomain: "sec.gov",
    // US government work: public domain.
    contentDisplay: "full",
    config: {},
  },
  {
    industry: "finance",
    name: "Banking Dive",
    kind: "rss",
    feedUrl: "https://www.bankingdive.com/feeds/news/",
    siteDomain: "bankingdive.com",
    // robots.txt asks for Crawl-delay 5.
    contentDisplay: "full",
    config: {},
  },
];
