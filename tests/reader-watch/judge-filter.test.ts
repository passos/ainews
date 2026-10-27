import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateEventWatches } from "../../src/pipeline/watch/evaluate";
import type { ModelClient } from "../../src/providers/models";

describe("reader watches stay off the admin judge path (#132)", () => {
  let sourceId: number;

  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM watch_hits`).run();
    await env.DB.prepare(`DELETE FROM watches`).run();
    await env.DB.prepare(
      `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
       VALUES (1, 'tech', 'Tech', 'review', '[]', '{}', 1, 1000)
       ON CONFLICT DO NOTHING`,
    ).run();
    const src = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (1, 'Reader Filter Source', 'https://example.com/reader-filter.xml', 'example.com', 'rss', 'active', 1000)
       ON CONFLICT DO NOTHING
       RETURNING id`,
    ).first<{ id: number }>();
    sourceId =
      src?.id ??
      (await env.DB.prepare(
        `SELECT id FROM sources WHERE feed_url = 'https://example.com/reader-filter.xml'`,
      ).first<{ id: number }>())!.id;
  });

  it("judges only the admin watch when a reader watch matches the same keyword", async () => {
    const eventId = Number(
      (
        await env.DB.prepare(
          `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
           VALUES (1, 'GPU pricing announced', 1, 1000, 1000)`,
        ).run()
      ).meta.last_row_id,
    );
    const articleId = Number(
      (
        await env.DB.prepare(
          `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
           VALUES (1, ?1, 'https://example.com/reader-filter-1', 'https://example.com/reader-filter-1', 'Official GPU pricing', 'Manufacturer announcement', 'sha-rf-1', 'grouped', 1000, 1000)`,
        )
          .bind(sourceId)
          .run()
      ).meta.last_row_id,
    );
    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha-rf-1', 'approved', 'admin', 1000)`,
    )
      .bind(articleId)
      .run();
    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at)
       VALUES (?1, ?2, 1000)`,
    )
      .bind(eventId, articleId)
      .run();

    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES ('gpu-admin', 'Official GPU Pricing', 'Must be an official announcement', '["GPU"]', 1, 'active', 500, 500)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at, owner_kind, token_hash)
       VALUES ('r-00000000000000aa', 'Reader GPU question', 'Reader criteria text', '["GPU"]', 1, 'active', 500, 500, 'reader', 'hash-rf-1')`,
    ).run();

    const judge = vi.fn().mockResolvedValue({ progress: { noul: 0.1 } });
    const models = {
      judge,
      generateText: vi.fn(),
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 1000, { models });

    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0]).toMatch(/^watch:judge:/);
    expect(res.evaluatedCount).toBe(1);
  });
});
