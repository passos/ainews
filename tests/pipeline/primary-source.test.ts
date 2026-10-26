import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractWhitelistedUrls } from "../../src/pipeline/evidence/verify";
import type { PipelineEnv } from "../../src/pipeline/messages";
import {
  trackDuePrimarySources,
  trackEventPrimarySources,
  type PrimaryTrackerDeps,
} from "../../src/pipeline/evidence/primary";
import { listPendingArticles } from "../../src/server/admin/ops";

describe("pipeline: primary source tracking (tests/pipeline/primary-source.test.ts)", () => {
  let eventId: number;
  let sourceId: number;
  let arxivSourceId: number;

  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM claim_evidence`).run();
    await env.DB.prepare(`DELETE FROM claims`).run();
    await env.DB.prepare(`DELETE FROM event_artifacts`).run();
    await env.DB.prepare(`DELETE FROM event_articles`).run();
    await env.DB.prepare(`DELETE FROM analyses`).run();
    await env.DB.prepare(`DELETE FROM reviews`).run();
    await env.DB.prepare(`DELETE FROM articles`).run();
    await env.DB.prepare(`DELETE FROM events`).run();
    await env.DB.prepare(`DELETE FROM sources`).run();

    await env.DB.prepare(
      `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
       VALUES (1, 'technology', 'Technology', 'auto', '["arxiv.org", "whitehouse.gov"]', '{}', 1, 1000)
       ON CONFLICT (id) DO UPDATE SET publish_mode = 'auto', primary_domains = excluded.primary_domains`,
    ).run();

    const src = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (1, 'Tech Crunch', 'https://techcrunch.com/feed', 'techcrunch.com', 'rss', 'active', 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    sourceId = src!.id;

    const arxivSrc = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (1, 'arXiv cs.AI', 'https://rss.arxiv.org/rss/cs.AI', 'arxiv.org', 'rss', 'active', 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    arxivSourceId = arxivSrc!.id;
    await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (1, 'White House', 'https://www.whitehouse.gov/feed/', 'whitehouse.gov', 'rss', 'active', 1000)`,
    ).run();

    const ev = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Quantum Discovery Announced', 1, 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    eventId = ev!.id;
  });

  describe("extractWhitelistedUrls", () => {
    const primary = ["arxiv.org", "sec.gov"];

    it("extracts whitelisted URLs from markdown links and text, ignoring external domains", () => {
      const markdown = `
A new paper was posted on arXiv: [Read Paper](https://arxiv.org/abs/2412.19437?ref=twitter).
Also see our discussion at https://reddit.com/r/MachineLearning and blog at https://random-blog.com/post.
Subdomains of whitelisted domains are also included: [Sub](https://sub.sec.gov/filings/123).
      `;

      const urls = extractWhitelistedUrls(markdown, primary);
      expect(urls.length).toBe(2);
      expect(urls).toContain("https://arxiv.org/abs/2412.19437?ref=twitter");
      expect(urls).toContain("https://sub.sec.gov/filings/123");
      expect(urls).not.toContain("https://random-blog.com/post");
      expect(urls).not.toContain("https://reddit.com/r/MachineLearning");
    });

    it("rejects non-http protocols and malformed URLs", () => {
      const markdown = `
Bad link: [Exploit](javascript:alert(1)) and [File](file:///etc/passwd).
Whitelisted valid: [Paper](https://arxiv.org/abs/1234.5678).
      `;
      const urls = extractWhitelistedUrls(markdown, primary);
      expect(urls).toEqual(["https://arxiv.org/abs/1234.5678"]);
    });

    it("returns empty array when primaryDomains is empty", () => {
      expect(
        extractWhitelistedUrls("Check https://arxiv.org/abs/1", []),
      ).toEqual([]);
    });
  });

  describe("trackEventPrimarySources", () => {
    it("ignores non-whitelisted links in body and makes 0 fetch calls", async () => {
      // 1. Seed approved article with body containing only non-whitelisted links
      const art = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (1, ?1, 'https://techcrunch.com/post1', 'https://techcrunch.com/post1', 'Tech Post', 'Summary', 'sha_no_white', 'grouped', 1000, 1000)
         RETURNING id`,
      )
        .bind(sourceId)
        .first<{ id: number }>();

      await env.DB.prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
         VALUES (?1, 'sha_no_white', 'approved', 'admin', 1000)`,
      )
        .bind(art!.id)
        .run();

      await env.DB.prepare(
        `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
         VALUES (?1, ?2, 1000, 1)`,
      )
        .bind(eventId, art!.id)
        .run();

      await env.BODIES.put(
        `bodies/${art!.id}/sha_no_white.md`,
        "Here is a cool article: check https://random-news.com/post and https://hacker-blog.org/item.",
      );

      const mockFetch = vi.fn();
      const deps: PrimaryTrackerDeps = {
        db: env.DB,
        bodies: env.BODIES,
        fetch: mockFetch as unknown as typeof fetch,
        now: () => 1000,
      };

      const result = await trackEventPrimarySources(
        deps,
        env,
        eventId,
        ["arxiv.org"],
        1000,
      );
      expect(result.trackedCount).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fetches whitelisted primary source, saves body in R2, creates approved article and bumps revision", async () => {
      // 1. Seed approved article linking to arxiv.org
      const art = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (1, ?1, 'https://techcrunch.com/post2', 'https://techcrunch.com/post2', 'Reporting on Breakthrough', 'Summary', 'sha_with_white', 'grouped', 1000, 1000)
         RETURNING id`,
      )
        .bind(sourceId)
        .first<{ id: number }>();

      await env.DB.prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
         VALUES (?1, 'sha_with_white', 'approved', 'admin', 1000)`,
      )
        .bind(art!.id)
        .run();

      await env.DB.prepare(
        `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
         VALUES (?1, ?2, 1000, 1)`,
      )
        .bind(eventId, art!.id)
        .run();

      await env.BODIES.put(
        `bodies/${art!.id}/sha_with_white.md`,
        "New research claims 500-qubit threshold reached. Full preprint available at [arXiv:2412.19437](https://arxiv.org/abs/2412.19437).",
      );

      // Mock fetch for robots.txt and page fetch
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("robots.txt")) {
          return new Response("User-agent: *\nAllow: /", { status: 200 });
        }
        if (url.includes("arxiv.org/abs/2412.19437")) {
          return new Response(
            `# 500-Qubit Processor Paper

We present experimental results and architectural specifications for a 500-qubit superconducting quantum processor.
Our measurements demonstrate average single-qubit gate fidelities of 99.95% and two-qubit gate fidelities of 99.6% across all active couplers.
Detailed calibration routines, error budgets, and benchmark comparisons with earlier 127-qubit systems are provided in the appendix.`,
            {
              status: 200,
              headers: { "Content-Type": "text/markdown" },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const qArtifactsSent: unknown[] = [];
      const qEvidenceSent: unknown[] = [];

      const deps: PrimaryTrackerDeps = {
        db: env.DB,
        bodies: env.BODIES,
        fetch: mockFetch as unknown as typeof fetch,
        now: () => 2000,
        qArtifacts: { send: async (msg) => qArtifactsSent.push(msg) },
        qEvidence: { send: async (msg) => qEvidenceSent.push(msg) },
      };

      const result = await trackEventPrimarySources(
        deps,
        env,
        eventId,
        ["arxiv.org"],
        2000,
      );
      expect(result.trackedCount).toBe(1);

      // 1. Verify article was added to articles table in stage grouped with parsed markdown title
      const primaryArt = await env.DB.prepare(
        `SELECT id, title, canonical_url, stage, body_sha FROM articles WHERE canonical_url = 'https://arxiv.org/abs/2412.19437'`,
      ).first<{
        id: number;
        title: string;
        canonical_url: string;
        stage: string;
        body_sha: string;
      }>();
      expect(primaryArt).not.toBeNull();
      expect(primaryArt!.stage).toBe("grouped");
      expect(primaryArt!.title).toBe("500-Qubit Processor Paper");

      // 2. Verify review was auto-approved
      const review = await env.DB.prepare(
        `SELECT decision, reviewer FROM reviews WHERE article_id = ?1`,
      )
        .bind(primaryArt!.id)
        .first<{ decision: string; reviewer: string }>();
      expect(review?.decision).toBe("approved");
      expect(review?.reviewer).toBe("system:primary_tracker");

      // 2b. Verify analysis was created with primary_source tag
      const analysis = await env.DB.prepare(
        `SELECT evidence_tags FROM analyses WHERE article_id = ?1`,
      )
        .bind(primaryArt!.id)
        .first<{ evidence_tags: string }>();
      expect(analysis).not.toBeNull();
      expect(analysis!.evidence_tags).toContain("primary_source");

      // 3. Verify event_articles joined at revision 2
      const ea = await env.DB.prepare(
        `SELECT input_revision FROM event_articles WHERE event_id = ?1 AND article_id = ?2`,
      )
        .bind(eventId, primaryArt!.id)
        .first<{ input_revision: number }>();
      expect(ea?.input_revision).toBe(2);

      // 4. Verify event revision bumped to 2
      const eventRow = await env.DB.prepare(
        `SELECT revision FROM events WHERE id = ?1`,
      )
        .bind(eventId)
        .first<{ revision: number }>();
      expect(eventRow?.revision).toBe(2);

      // 5. Verify R2 body was stored
      const r2Obj = await env.BODIES.get(
        `bodies/${primaryArt!.id}/${primaryArt!.body_sha}.md`,
      );
      expect(r2Obj).not.toBeNull();
      const r2Text = await r2Obj!.text();
      expect(r2Text).toContain("# 500-Qubit Processor Paper");

      // 6. Verify queues received notification
      expect(qArtifactsSent.length).toBe(1);
      expect(qEvidenceSent.length).toBe(1);
    });

    it("records dropped article if robots.txt disallows the URL, preventing retry loops", async () => {
      const art = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (1, ?1, 'https://techcrunch.com/post3', 'https://techcrunch.com/post3', 'Reporting', 'Summary', 'sha_robots', 'grouped', 1000, 1000)
         RETURNING id`,
      )
        .bind(sourceId)
        .first<{ id: number }>();

      await env.DB.prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
         VALUES (?1, 'sha_robots', 'approved', 'admin', 1000)`,
      )
        .bind(art!.id)
        .run();

      await env.DB.prepare(
        `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
         VALUES (?1, ?2, 1000, 1)`,
      )
        .bind(eventId, art!.id)
        .run();

      await env.BODIES.put(
        `bodies/${art!.id}/sha_robots.md`,
        "Check secret government briefing: https://whitehouse.gov/secret-report",
      );

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("robots.txt")) {
          return new Response("User-agent: *\nDisallow: /", { status: 200 });
        }
        return new Response("OK", { status: 200 });
      });

      const deps: PrimaryTrackerDeps = {
        db: env.DB,
        bodies: env.BODIES,
        fetch: mockFetch as unknown as typeof fetch,
        now: () => 1000,
      };

      const result = await trackEventPrimarySources(
        deps,
        env,
        eventId,
        ["whitehouse.gov"],
        1000,
      );
      expect(result.trackedCount).toBe(0);

      // Verify recorded as dropped
      const dropped = await env.DB.prepare(
        `SELECT stage FROM articles WHERE canonical_url = 'https://whitehouse.gov/secret-report'`,
      ).first<{ stage: string }>();
      expect(dropped?.stage).toBe("dropped");
    });

    it("does not auto-approve or link articles in Finance section", async () => {
      await env.DB.prepare(
        `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
         VALUES (2, 'finance', 'Finance', 'review', '["sec.gov"]', '{}', 1, 1000)
         ON CONFLICT (id) DO UPDATE SET slug = 'finance'`,
      ).run();

      const finEv = await env.DB.prepare(
        `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
         VALUES (2, 'Quarterly Earnings Filing', 1, 1000, 1000)
         RETURNING id`,
      ).first<{ id: number }>();

      const finArt = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (2, ?1, 'https://techcrunch.com/fin1', 'https://techcrunch.com/fin1', 'Earnings Report', 'Summary', 'sha_fin', 'grouped', 1000, 1000)
         RETURNING id`,
      )
        .bind(sourceId)
        .first<{ id: number }>();

      await env.DB.prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
         VALUES (?1, 'sha_fin', 'approved', 'admin', 1000)`,
      )
        .bind(finArt!.id)
        .run();

      await env.DB.prepare(
        `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
         VALUES (?1, ?2, 1000, 1)`,
      )
        .bind(finEv!.id, finArt!.id)
        .run();

      await env.BODIES.put(
        `bodies/${finArt!.id}/sha_fin.md`,
        `See official SEC filing at https://sec.gov/filing/10k.`,
      );

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("robots.txt")) {
          return new Response("User-agent: *\nAllow: /", { status: 200 });
        }
        if (url.includes("sec.gov/filing/10k")) {
          return new Response(
            `# Form 10-K Annual Report

This annual report contains detailed financial statements and audit certifications for fiscal year 2026.
Consolidated balance sheets, income statements, and cash flows are presented herein in full compliance with GAAP standards.`,
            {
              status: 200,
              headers: { "Content-Type": "text/markdown" },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const deps: PrimaryTrackerDeps = {
        db: env.DB,
        bodies: env.BODIES,
        fetch: mockFetch as unknown as typeof fetch,
        now: () => 2000,
      };

      const result = await trackEventPrimarySources(
        deps,
        env,
        finEv!.id,
        ["sec.gov"],
        2000,
      );
      // In Finance, not auto-approved -> trackedCount 0 for auto-linked
      expect(result.trackedCount).toBe(0);

      // Article was inserted with stage 'analyzed' and no review yet (pending human review)
      const secArt = await env.DB.prepare(
        `SELECT id, stage FROM articles WHERE canonical_url = 'https://sec.gov/filing/10k'`,
      ).first<{ id: number; stage: string }>();
      expect(secArt).not.toBeNull();
      expect(secArt!.stage).toBe("analyzed");

      const rev = await env.DB.prepare(
        `SELECT decision FROM reviews WHERE article_id = ?1`,
      )
        .bind(secArt!.id)
        .first<{ decision: string }>();
      expect(rev).toBeNull();

      // Event revision remains 1
      const evRow = await env.DB.prepare(
        `SELECT revision FROM events WHERE id = ?1`,
      )
        .bind(finEv!.id)
        .first<{ revision: number }>();
      expect(evRow?.revision).toBe(1);
    });

    it("skips candidate article already assigned to another event without unique constraint failure", async () => {
      // Event 2 with its own article
      const ev2 = await env.DB.prepare(
        `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
         VALUES (1, 'Second Event', 1, 1000, 1000)
         RETURNING id`,
      ).first<{ id: number }>();

      const otherArt = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (1, ?1, 'https://arxiv.org/abs/2412.9999', 'https://arxiv.org/abs/2412.9999', 'Other Paper', 'Summary', 'sha_other', 'grouped', 1000, 1000)
         RETURNING id`,
      )
        .bind(sourceId)
        .first<{ id: number }>();

      // Assigned to ev2
      await env.DB.prepare(
        `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
         VALUES (?1, ?2, 1000, 1)`,
      )
        .bind(ev2!.id, otherArt!.id)
        .run();

      // Now event 1 mentions https://arxiv.org/abs/2412.9999
      const art = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (1, ?1, 'https://techcrunch.com/post_conflict', 'https://techcrunch.com/post_conflict', 'Conflict Post', 'Summary', 'sha_conf', 'grouped', 1000, 1000)
         RETURNING id`,
      )
        .bind(sourceId)
        .first<{ id: number }>();

      await env.DB.prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
         VALUES (?1, 'sha_conf', 'approved', 'admin', 1000)`,
      )
        .bind(art!.id)
        .run();

      await env.DB.prepare(
        `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
         VALUES (?1, ?2, 1000, 1)`,
      )
        .bind(eventId, art!.id)
        .run();

      await env.BODIES.put(
        `bodies/${art!.id}/sha_conf.md`,
        "Paper already in event 2: https://arxiv.org/abs/2412.9999.",
      );

      const mockFetch = vi.fn();
      const deps: PrimaryTrackerDeps = {
        db: env.DB,
        bodies: env.BODIES,
        fetch: mockFetch as unknown as typeof fetch,
        now: () => 1000,
      };

      // Must complete without throwing UNIQUE constraint failed: event_articles.article_id
      const res = await trackEventPrimarySources(
        deps,
        env,
        eventId,
        ["arxiv.org"],
        1000,
      );
      expect(res.trackedCount).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    /** An approved, linked report on `industryId` whose body is `body`. */
    async function seedApprovedReport(
      evId: number,
      industryId: number,
      sha: string,
      body: string,
    ): Promise<number> {
      const art = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (?1, ?2, ?3, ?3, 'Report', 'Summary', ?4, 'grouped', 1000, 1000)
         RETURNING id`,
      )
        .bind(industryId, sourceId, `https://techcrunch.com/${sha}`, sha)
        .first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
         VALUES (?1, ?2, 'approved', 'admin', 1000)`,
      )
        .bind(art!.id, sha)
        .run();
      await env.DB.prepare(
        `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
         VALUES (?1, ?2, 1000, 1)`,
      )
        .bind(evId, art!.id)
        .run();
      await env.BODIES.put(`bodies/${art!.id}/${sha}.md`, body);
      return art!.id;
    }

    /** robots.txt allows everything; every other URL is a markdown page. */
    function primaryPageFetch() {
      return vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("robots.txt")) {
          return new Response("User-agent: *\nAllow: /", { status: 200 });
        }
        return new Response(
          "# Primary Document\n\n" +
            "Detailed experimental evidence and measured results. ".repeat(10),
          { status: 200, headers: { "Content-Type": "text/markdown" } },
        );
      });
    }

    async function countSources(): Promise<number> {
      const row = await env.DB.prepare(`SELECT count(*) n FROM sources`).first<{
        n: number;
      }>();
      return row!.n;
    }

    it("review section: a new primary page waits in the review queue with no system approval", async () => {
      await env.DB.prepare(
        `UPDATE industries SET publish_mode='review' WHERE id=1`,
      ).run();
      await seedApprovedReport(
        eventId,
        1,
        "sha_review_new",
        "Full preprint available at [arXiv:2412.19437](https://arxiv.org/abs/2412.19437).",
      );
      const mockFetch = primaryPageFetch();
      const sourcesBefore = await countSources();

      const result = await trackEventPrimarySources(
        {
          db: env.DB,
          bodies: env.BODIES,
          fetch: mockFetch as unknown as typeof fetch,
          now: () => 2000,
        },
        env,
        eventId,
        ["arxiv.org"],
        2000,
      );

      const systemReviews = await env.DB.prepare(
        `SELECT count(*) n FROM reviews WHERE reviewer LIKE 'system:%'`,
      ).first<{ n: number }>();
      expect(systemReviews!.n).toBe(0);

      const primaryArt = await env.DB.prepare(
        `SELECT id, stage, source_id FROM articles WHERE canonical_url = 'https://arxiv.org/abs/2412.19437'`,
      ).first<{ id: number; stage: string; source_id: number }>();
      expect(primaryArt).not.toBeNull();
      expect(primaryArt!.stage).toBe("analyzed");
      expect(primaryArt!.source_id).toBe(arxivSourceId);

      const analysis = await env.DB.prepare(
        `SELECT evidence_tags FROM analyses WHERE article_id = ?1 AND prompt_version = 'primary_tracker'`,
      )
        .bind(primaryArt!.id)
        .first<{ evidence_tags: string }>();
      expect(JSON.parse(analysis!.evidence_tags).origin_event_id).toBe(eventId);

      const linked = await env.DB.prepare(
        `SELECT 1 FROM event_articles WHERE article_id = ?1`,
      )
        .bind(primaryArt!.id)
        .first();
      expect(linked).toBeNull();
      const ev = await env.DB.prepare(
        `SELECT revision FROM events WHERE id = ?1`,
      )
        .bind(eventId)
        .first<{ revision: number }>();
      expect(ev!.revision).toBe(1);
      expect(result.trackedCount).toBe(0);

      expect(await countSources()).toBe(sourcesBefore);

      const pending = (await listPendingArticles(env.DB)).map((a) => a.id);
      expect(pending).toContain(primaryArt!.id);
    });

    it("review section: retrying an orphaned primary article writes no system approval", async () => {
      await env.DB.prepare(
        `UPDATE industries SET publish_mode='review' WHERE id=1`,
      ).run();
      const orphan = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (1, ?1, 'https://arxiv.org/abs/orphan', 'https://arxiv.org/abs/orphan', 'Orphan', 'sha_orphan', 'grouped', 1000, 1000)
         RETURNING id`,
      )
        .bind(arxivSourceId)
        .first<{ id: number }>();
      await seedApprovedReport(
        eventId,
        1,
        "sha_orphan_link",
        "Preprint at [arXiv](https://arxiv.org/abs/orphan).",
      );
      const mockFetch = vi.fn();

      await trackEventPrimarySources(
        {
          db: env.DB,
          bodies: env.BODIES,
          fetch: mockFetch as unknown as typeof fetch,
          now: () => 2000,
        },
        env,
        eventId,
        ["arxiv.org"],
        2000,
      );

      const review = await env.DB.prepare(
        `SELECT 1 FROM reviews WHERE article_id = ?1`,
      )
        .bind(orphan!.id)
        .first();
      expect(review).toBeNull();
      const linked = await env.DB.prepare(
        `SELECT 1 FROM event_articles WHERE article_id = ?1`,
      )
        .bind(orphan!.id)
        .first();
      expect(linked).toBeNull();
      const ev = await env.DB.prepare(
        `SELECT revision FROM events WHERE id = ?1`,
      )
        .bind(eventId)
        .first<{ revision: number }>();
      expect(ev!.revision).toBe(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not insert sources and attributes a fetched page to the matching section source", async () => {
      await seedApprovedReport(
        eventId,
        1,
        "sha_attr",
        "Full preprint available at [arXiv:2412.19437](https://arxiv.org/abs/2412.19437).",
      );
      const mockFetch = primaryPageFetch();
      const sourcesBefore = await countSources();

      await trackEventPrimarySources(
        {
          db: env.DB,
          bodies: env.BODIES,
          fetch: mockFetch as unknown as typeof fetch,
          now: () => 2000,
        },
        env,
        eventId,
        ["arxiv.org"],
        2000,
      );

      expect(await countSources()).toBe(sourcesBefore);
      const primaryArt = await env.DB.prepare(
        `SELECT source_id FROM articles WHERE canonical_url = 'https://arxiv.org/abs/2412.19437'`,
      ).first<{ source_id: number }>();
      expect(primaryArt!.source_id).toBe(arxivSourceId);
      const hostSource = await env.DB.prepare(
        `SELECT 1 FROM sources WHERE feed_url = 'https://arxiv.org'`,
      ).first();
      expect(hostSource).toBeNull();
    });

    it("attaches a whitelisted URL with no matching source to the section's primary-documents placeholder", async () => {
      await env.DB.prepare(
        `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
         VALUES (2, 'finance', 'Finance', 'review', '[]', '{}', 1, 1000)
         ON CONFLICT DO NOTHING`,
      ).run();
      const otherSection = await env.DB.prepare(
        `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
         VALUES (2, 'NASA Wire', 'https://nasa.example/feed', 'nasa.gov', 'rss', 'active', 1000)
         RETURNING id`,
      ).first<{ id: number }>();
      const reportId = await seedApprovedReport(
        eventId,
        1,
        "sha_nasa",
        "Full report at [NASA](https://www.nasa.gov/report).",
      );
      const mockFetch = primaryPageFetch();
      const deps: PrimaryTrackerDeps = {
        db: env.DB,
        bodies: env.BODIES,
        fetch: mockFetch as unknown as typeof fetch,
        now: () => 2000,
      };

      const result = await trackEventPrimarySources(
        deps,
        env,
        eventId,
        ["arxiv.org", "nasa.gov"],
        2000,
      );

      expect(mockFetch).toHaveBeenCalled();
      expect(result.trackedCount).toBe(1);
      const { results: placeholders } = await env.DB.prepare(
        `SELECT id, industry_id, name, status, paused_reason, kind, site_domain
         FROM sources WHERE feed_url = 'system:primary-documents'`,
      ).all<{
        id: number;
        industry_id: number;
        name: string;
        status: string;
        paused_reason: string | null;
        kind: string;
        site_domain: string | null;
      }>();
      expect(placeholders).toHaveLength(1);
      const placeholder = placeholders[0];
      expect(placeholder).toMatchObject({
        industry_id: 1,
        name: "Primary documents (system)",
        status: "paused",
        paused_reason: null,
        kind: "html",
        site_domain: null,
      });
      const nasaArt = await env.DB.prepare(
        `SELECT source_id FROM articles WHERE url = 'https://www.nasa.gov/report'`,
      ).first<{ source_id: number }>();
      expect(nasaArt!.source_id).toBe(placeholder.id);
      expect(nasaArt!.source_id).not.toBe(otherSection!.id);

      // A second page on the same host reuses the placeholder and keeps an
      // admin rename (ON CONFLICT DO NOTHING, never DO UPDATE).
      await env.DB.prepare(
        `UPDATE sources SET name = 'Renamed by admin' WHERE id = ?1`,
      )
        .bind(placeholder.id)
        .run();
      await env.BODIES.put(
        `bodies/${reportId}/sha_nasa.md`,
        "Full report at [NASA](https://www.nasa.gov/report) and [annex](https://www.nasa.gov/report2).",
      );
      await trackEventPrimarySources(
        { ...deps, now: () => 999_000 },
        env,
        eventId,
        ["arxiv.org", "nasa.gov"],
        999_000,
      );
      const { results: after } = await env.DB.prepare(
        `SELECT id, name FROM sources WHERE feed_url = 'system:primary-documents'`,
      ).all<{ id: number; name: string }>();
      expect(after).toEqual([{ id: placeholder.id, name: "Renamed by admin" }]);
      const annex = await env.DB.prepare(
        `SELECT source_id FROM articles WHERE url = 'https://www.nasa.gov/report2'`,
      ).first<{ source_id: number }>();
      expect(annex!.source_id).toBe(placeholder.id);
    });

    it("a candidate source on the same domain does not own a primary page", async () => {
      const candidate = await env.DB.prepare(
        `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
         VALUES (1, 'NASA candidate', 'https://www.nasa.gov/rss/news', 'nasa.gov', 'rss', 'candidate', 1000)
         RETURNING id`,
      ).first<{ id: number }>();
      await seedApprovedReport(
        eventId,
        1,
        "sha_candidate",
        "Full report at [NASA](https://images.nasa.gov/candidate-doc).",
      );

      await trackEventPrimarySources(
        {
          db: env.DB,
          bodies: env.BODIES,
          fetch: primaryPageFetch() as unknown as typeof fetch,
          now: () => 2000,
        },
        env,
        eventId,
        ["nasa.gov"],
        2000,
      );

      const doc = await env.DB.prepare(
        `SELECT s.feed_url FROM articles a JOIN sources s ON s.id = a.source_id
         WHERE a.url = 'https://images.nasa.gov/candidate-doc'`,
      ).first<{ feed_url: string }>();
      expect(doc!.feed_url).toBe("system:primary-documents");
      const status = await env.DB.prepare(
        `SELECT status FROM sources WHERE id = ?1`,
      )
        .bind(candidate!.id)
        .first<{ status: string }>();
      expect(status!.status).toBe("candidate");
    });

    it("Finance gets no system approval even when its publish_mode is auto", async () => {
      await env.DB.prepare(
        `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
         VALUES (2, 'finance', 'Finance', 'auto', '["sec.gov"]', '{}', 1, 1000)
         ON CONFLICT (id) DO UPDATE SET slug = 'finance', publish_mode = 'auto', primary_domains = '["sec.gov"]'`,
      ).run();
      try {
        await env.DB.prepare(
          `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
           VALUES (2, 'SEC Press', 'https://www.sec.gov/news/pressreleases.rss', 'sec.gov', 'rss', 'active', 1000)`,
        ).run();
        const finEv = await env.DB.prepare(
          `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
           VALUES (2, 'Quarterly Earnings Filing', 1, 1000, 1000)
           RETURNING id`,
        ).first<{ id: number }>();
        await seedApprovedReport(
          finEv!.id,
          2,
          "sha_fin_auto",
          "See official SEC filing at https://sec.gov/filing/10k-auto.",
        );
        const mockFetch = primaryPageFetch();

        await trackEventPrimarySources(
          {
            db: env.DB,
            bodies: env.BODIES,
            fetch: mockFetch as unknown as typeof fetch,
            now: () => 2000,
          },
          env,
          finEv!.id,
          ["sec.gov"],
          2000,
        );

        const secArt = await env.DB.prepare(
          `SELECT id, stage FROM articles WHERE canonical_url = 'https://sec.gov/filing/10k-auto'`,
        ).first<{ id: number; stage: string }>();
        expect(secArt).not.toBeNull();
        expect(secArt!.stage).toBe("analyzed");
        const rev = await env.DB.prepare(
          `SELECT 1 FROM reviews WHERE article_id = ?1`,
        )
          .bind(secArt!.id)
          .first();
        expect(rev).toBeNull();
      } finally {
        await env.DB.prepare(
          `UPDATE industries SET publish_mode = 'review' WHERE id = 2`,
        ).run();
      }
    });
  });

  describe("trackDuePrimarySources", () => {
    it("returns empty array and does not query when COLLECT_ENABLED is false", async () => {
      const mockEnv = {
        ...env,
        COLLECT_ENABLED: "false",
      };
      const processed = await trackDuePrimarySources(
        mockEnv as unknown as PipelineEnv,
        1000,
      );
      expect(processed).toEqual([]);
    });

    it("events without a primary whitelist do not starve configured events", async () => {
      const { seedEvent, seedArticle, seedEventArticle, seedReview } =
        await import("../publication/helpers");
      await env.DB.prepare(
        "UPDATE industries SET primary_domains='[\"arxiv.org\"]' WHERE id=1",
      ).run();
      await env.DB.prepare(
        "INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at) VALUES (2, 'finance', 'Finance', 'review', '[]', '{}', 1, 1000) ON CONFLICT(id) DO UPDATE SET primary_domains='[]'",
      ).run();
      const src2 = await env.DB.prepare(
        "INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at) VALUES (2, 'Finance Wire', 'https://finance.example/feed', 'finance.example', 'rss', 'active', 1000) RETURNING id",
      ).first<{ id: number }>();

      const eligible = await seedEvent(1, "Eligible older event", 1);
      const eligibleArticle = await seedArticle({
        industryId: 1,
        sourceId,
        title: "Eligible report",
      });
      await seedEventArticle(eligible, eligibleArticle, 0, 1);
      await seedReview(eligibleArticle, "approved");

      for (let i = 1; i <= 10; i++) {
        const event = await seedEvent(2, `No whitelist ${i}`, 1);
        await env.DB.prepare("UPDATE events SET updated_at=? WHERE id=?")
          .bind(i, event)
          .run();
        const article = await seedArticle({
          industryId: 2,
          sourceId: src2!.id,
          title: `Report ${i}`,
        });
        await seedEventArticle(event, article, i, 1);
        await seedReview(article, "approved");
      }

      const scanned: string[] = [];
      const get = vi.fn(async (key: string) => {
        scanned.push(key);
        return null;
      });
      const scheduled = {
        ...env,
        COLLECT_ENABLED: "true",
        BODIES: { get },
      } as unknown as PipelineEnv;

      for (let i = 0; i < 3; i++)
        await trackDuePrimarySources(scheduled, 1000 + i * 600000);

      expect(scanned).toContain(`bodies/${eligibleArticle}/sha-current.md`);
    });
  });
});
