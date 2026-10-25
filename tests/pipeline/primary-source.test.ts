import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractWhitelistedUrls } from "../../src/pipeline/evidence/verify";
import {
  trackEventPrimarySources,
  type PrimaryTrackerDeps,
} from "../../src/pipeline/evidence/primary";

describe("pipeline: primary source tracking (tests/pipeline/primary-source.test.ts)", () => {
  let eventId: number;
  let sourceId: number;

  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM event_articles`).run();
    await env.DB.prepare(`DELETE FROM reviews`).run();
    await env.DB.prepare(`DELETE FROM articles`).run();
    await env.DB.prepare(`DELETE FROM events`).run();
    await env.DB.prepare(`DELETE FROM sources`).run();

    await env.DB.prepare(
      `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
       VALUES (1, 'technology', 'Technology', 'auto', '["arxiv.org", "whitehouse.gov"]', '{}', 1, 1000)
       ON CONFLICT DO NOTHING`,
    ).run();

    const src = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (1, 'Tech Crunch', 'https://techcrunch.com/feed', 'techcrunch.com', 'rss', 'active', 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    sourceId = src!.id;

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

      // 1. Verify article was added to articles table in stage grouped
      const primaryArt = await env.DB.prepare(
        `SELECT id, canonical_url, stage, body_sha FROM articles WHERE canonical_url = 'https://arxiv.org/abs/2412.19437'`,
      ).first<{
        id: number;
        canonical_url: string;
        stage: string;
        body_sha: string;
      }>();
      expect(primaryArt).not.toBeNull();
      expect(primaryArt!.stage).toBe("grouped");

      // 2. Verify review was auto-approved
      const review = await env.DB.prepare(
        `SELECT decision, reviewer FROM reviews WHERE article_id = ?1`,
      )
        .bind(primaryArt!.id)
        .first<{ decision: string; reviewer: string }>();
      expect(review?.decision).toBe("approved");
      expect(review?.reviewer).toBe("system:primary_tracker");

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
  });
});
