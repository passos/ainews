import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { computeRevisionDiff } from "../../src/pipeline/evidence/diff";
import { generateEventArtifacts } from "../../src/pipeline/artifacts/build";
import type { PipelineEnv } from "../../src/pipeline/messages";
import type { ModelClient } from "../../src/providers/models";

describe("pipeline: change detection and revision diff (tests/pipeline/change-detection.test.ts)", () => {
  let eventId: number;

  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM event_artifacts`).run();
    await env.DB.prepare(`DELETE FROM claims`).run();
    await env.DB.prepare(`DELETE FROM event_articles`).run();
    await env.DB.prepare(`DELETE FROM analyses`).run();
    await env.DB.prepare(`DELETE FROM reviews`).run();
    await env.DB.prepare(`DELETE FROM articles`).run();
    await env.DB.prepare(`DELETE FROM events`).run();
    await env.DB.prepare(`DELETE FROM sources`).run();

    await env.DB.prepare(
      `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
       VALUES (1, 'technology', 'Technology', 'auto', '["arxiv.org"]', '{}', 1, 1000)
       ON CONFLICT DO NOTHING`,
    ).run();

    await env.DB.prepare(
      `INSERT INTO sources (id, industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (1, 1, 'Tech Wire', 'https://techwire.com/feed', 'techwire.com', 'rss', 'active', 1000)
       ON CONFLICT DO NOTHING`,
    ).run();

    const ev = await env.DB.prepare(
      `INSERT INTO events (industry_id, title, revision, created_at, updated_at)
       VALUES (1, 'Breakthrough LLM Architecture Announced', 1, 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();
    eventId = ev!.id;
  });

  it("computes initial report for Revision 1", async () => {
    // Insert article 1 in revision 1
    const art = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, 1, 'https://techwire.com/art1', 'https://techwire.com/art1', 'Company claims 10x faster reasoning', 'Summary 1', 'sha1', 'grouped', 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha1', 'approved', 'admin', 1000)`,
    )
      .bind(art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
       VALUES (?1, ?2, 1000, 1)`,
    )
      .bind(eventId, art!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO claims (event_id, claim_text, claim_type, consensus_status, primary_source_preferred, reality_check, status, input_revision, prompt_version, model, created_at)
       VALUES (?1, 'Company claims 10x speedup over current models', 'fact', 'unverified', 0, 'vendor_only', 'published', 1, 'v1', 'mock', 1000)`,
    )
      .bind(eventId)
      .run();

    const diff = await computeRevisionDiff(env.DB, eventId, 1);
    expect(diff).not.toBeNull();
    expect(diff!.revision).toBe(1);
    expect(diff!.summary).toContain("Initial report");
    expect(diff!.newSources).toContain("Tech Wire");
    expect(diff!.newClaims).toContain(
      "Company claims 10x speedup over current models",
    );
    expect(diff!.changedClaims.length).toBe(0);
  });

  it("computes new sources and new claims in Revision 2", async () => {
    // 1. Revision 1 state
    const art1 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, 1, 'https://techwire.com/art1', 'https://techwire.com/art1', 'Vendor Press Release', 'Summary 1', 'sha1', 'grouped', 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha1', 'approved', 'admin', 1000)`,
    )
      .bind(art1!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
       VALUES (?1, ?2, 1000, 1)`,
    )
      .bind(eventId, art1!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO claims (event_id, claim_text, claim_type, consensus_status, primary_source_preferred, reality_check, status, input_revision, prompt_version, model, created_at)
       VALUES (?1, 'Architecture improves token throughput 10x', 'fact', 'unverified', 0, 'vendor_only', 'published', 1, 'v1', 'mock', 1000)`,
    )
      .bind(eventId)
      .run();

    // 2. Revision 2 state: add Source 2 (ArXiv)
    await env.DB.prepare(
      `INSERT INTO sources (id, industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (2, 1, 'arXiv cs.AI', 'https://arxiv.org/feed', 'arxiv.org', 'rss', 'active', 2000)
       ON CONFLICT DO NOTHING`,
    ).run();

    const art2 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, 2, 'https://arxiv.org/abs/2412.0001', 'https://arxiv.org/abs/2412.0001', 'Independent Benchmark of Architecture', 'Summary 2', 'sha2', 'grouped', 2000, 2000)
       RETURNING id`,
    ).first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha2', 'approved', 'admin', 2000)`,
    )
      .bind(art2!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
       VALUES (?1, ?2, 2000, 2)`,
    )
      .bind(eventId, art2!.id)
      .run();

    await env.DB.prepare(
      `UPDATE events SET revision = 2, updated_at = 2000 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();

    // In revision 2, prior claim is updated, and a new claim is introduced
    await env.DB.prepare(
      `INSERT INTO claims (event_id, claim_text, claim_type, consensus_status, primary_source_preferred, reality_check, status, input_revision, prompt_version, model, created_at)
       VALUES (?1, 'Architecture improves token throughput 10x', 'fact', 'disputed', 1, 'independent_disputed', 'published', 2, 'v1', 'mock', 2000),
              (?1, 'Independent tests reveal latency regression under high concurrency', 'fact', 'verified', 1, 'independent_verified', 'published', 2, 'v1', 'mock', 2000)`,
    )
      .bind(eventId)
      .run();

    const diff = await computeRevisionDiff(env.DB, eventId, 2);
    expect(diff).not.toBeNull();
    expect(diff!.revision).toBe(2);
    expect(diff!.newSources).toContain("arXiv cs.AI");
    expect(diff!.newClaims).toContain(
      "Independent tests reveal latency regression under high concurrency",
    );
    expect(diff!.changedClaims.length).toBe(1);
    expect(diff!.changedClaims[0]).toContain(
      "vendor_only → independent_disputed",
    );
    expect(diff!.summary).toContain("New claims identified");
  });

  it("stores revision_diff artifact in event_artifacts during generateEventArtifacts for Revision 2", async () => {
    // Setup approved article 1 (Revision 1)
    const art1 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, 1, 'https://techwire.com/art1', 'https://techwire.com/art1', 'Tech Announcement', 'Summary 1', 'sha1', 'grouped', 1000, 1000)
       RETURNING id`,
    ).first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha1', 'approved', 'admin', 1000)`,
    )
      .bind(art1!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
       VALUES (?1, ?2, 1000, 1)`,
    )
      .bind(eventId, art1!.id)
      .run();

    // Setup approved article 2 (Revision 2)
    const art2 = await env.DB.prepare(
      `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, summary, body_sha, stage, stage_updated_at, fetched_at)
       VALUES (1, 1, 'https://techwire.com/art2', 'https://techwire.com/art2', 'Followup Analysis', 'Summary 2', 'sha2', 'grouped', 2000, 2000)
       RETURNING id`,
    ).first<{ id: number }>();

    await env.DB.prepare(
      `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at)
       VALUES (?1, 'sha2', 'approved', 'admin', 2000)`,
    )
      .bind(art2!.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
       VALUES (?1, ?2, 2000, 2)`,
    )
      .bind(eventId, art2!.id)
      .run();

    await env.DB.prepare(
      `UPDATE events SET revision = 2, updated_at = 2000 WHERE id = ?1`,
    )
      .bind(eventId)
      .run();

    const mockModels = {
      generateText: async () => ({
        text: JSON.stringify({
          whatHappened: "H",
          whatIsNew: "N",
          whatEvidenceExists: "E",
          whatToWatchNext: "W",
        }),
        finishReason: "STOP",
      }),
    } as unknown as ModelClient;

    await generateEventArtifacts(env as PipelineEnv, eventId, 2000, {
      db: env.DB,
      models: mockModels,
      bodies: env.BODIES,
    });

    // Check event_artifacts has revision_diff for revision 2
    const diffArtifact = await env.DB.prepare(
      `SELECT type, content, status FROM event_artifacts WHERE event_id = ?1 AND type = 'revision_diff' AND input_revision = 2`,
    )
      .bind(eventId)
      .first<{ type: string; content: string; status: string }>();

    expect(diffArtifact).not.toBeNull();
    expect(diffArtifact!.type).toBe("revision_diff");
    expect(diffArtifact!.status).toBe("published");
    const parsed = JSON.parse(diffArtifact!.content);
    expect(parsed.revision).toBe(2);
    expect(parsed.summary).toBeTruthy();
  });

  it("names a placeholder-source article by its document host, never the placeholder", async () => {
    await env.DB.prepare(
      `INSERT INTO sources (id, industry_id, name, feed_url, kind, status, created_at)
       VALUES (2, 1, 'Primary documents (system)', 'system:primary-documents', 'html', 'paused', 1000)
       ON CONFLICT DO NOTHING`,
    ).run();
    for (const [rev, url, sha] of [
      [1, "https://www.nasa.gov/initial", "shaPh1"],
      [2, "https://www.nasa.gov/followup", "shaPh2"],
    ] as const) {
      const art = await env.DB.prepare(
        `INSERT INTO articles (industry_id, source_id, canonical_url, url, title, body_sha, stage, stage_updated_at, fetched_at)
         VALUES (1, 2, ?1, ?1, 'Primary doc', ?2, 'grouped', 1000, 1000) RETURNING id`,
      )
        .bind(url, sha)
        .first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, ?2, 'approved', 'admin', 1000)`,
      )
        .bind(art!.id, sha)
        .run();
      await env.DB.prepare(
        `INSERT INTO event_articles (event_id, article_id, created_at, input_revision) VALUES (?1, ?2, 1000, ?3)`,
      )
        .bind(eventId, art!.id, rev)
        .run();
    }

    for (const rev of [1, 2]) {
      const diff = await computeRevisionDiff(env.DB, eventId, rev);
      const text = JSON.stringify(diff);
      expect(text).not.toContain("Primary documents");
      expect(diff!.newSources).toEqual(["nasa.gov"]);
      expect(diff!.summary).toContain("nasa.gov");
    }
  });
});
