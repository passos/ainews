// Seed sources (#8). Only Technology has any: the owner decides which sources
// the other sections watch (AGENTS.md). The `exclude` rules are drafts that
// wait for the owner's answers to gate questions (b) and (c).
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
}

export const SEED_SOURCES: SeedSource[] = [
  {
    industry: "technology",
    name: "arXiv cs.AI",
    kind: "rss",
    feedUrl: "https://rss.arxiv.org/rss/cs.AI",
    siteDomain: "arxiv.org",
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
    feedUrl: "https://www.technologyreview.com/feed/",
    siteDomain: "technologyreview.com",
    config: { exclude: [{ field: "category", values: ["sponsored"] }] },
  },
];
