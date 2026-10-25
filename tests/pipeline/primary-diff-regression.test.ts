import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { getEvent } from "../../src/server/publication/events";
import { syncRevisionDiff } from "../../src/pipeline/evidence/diff";
import { trackEventPrimarySources } from "../../src/pipeline/evidence/primary";
import { decideReview, reviewArtifact } from "../../src/server/admin/ops";
import {
  db,
  resetPublication,
  seedSections,
  seedEvent,
  seedArticle,
  seedEventArticle,
  seedReview,
} from "../publication/helpers";

let tech: { industryId: number; sourceId: number };
beforeEach(async () => {
  await resetPublication();
  await env.DB.prepare("DELETE FROM fetch_hosts").run();
  ({ technology: tech } = await seedSections());
});

it("historical intermediate diffs can complete editorial review", async () => {
  await env.DB.prepare(
    "UPDATE industries SET publish_mode='review',primary_domains='[\"arxiv.org\",\"whitehouse.gov\"]' WHERE id=?",
  )
    .bind(tech.industryId)
    .run();
  const eventId = await seedEvent(tech.industryId, "Event", 1);
  const report = await seedArticle({ ...tech, title: "Approved report" });
  await seedEventArticle(eventId, report, 1000, 1);
  await seedReview(report, "approved");
  await env.BODIES.put(
    `bodies/${report}/sha-current.md`,
    "[Paper](https://arxiv.org/abs/new) [Release](https://whitehouse.gov/release)",
  );
  const mockFetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes("robots.txt")
      ? new Response("User-agent: *\nAllow: /", { status: 200 })
      : new Response(
          "# Primary\n\n" +
            "Detailed experimental evidence and measured results. ".repeat(10),
          { headers: { "Content-Type": "text/markdown" } },
        ),
  );
  expect(
    (
      await trackEventPrimarySources(
        { db: env.DB, bodies: env.BODIES, fetch: mockFetch },
        env,
        eventId,
        [],
        1000,
      )
    ).trackedCount,
  ).toBe(2);
  expect(
    await env.DB.prepare("SELECT revision FROM events WHERE id=?")
      .bind(eventId)
      .first(),
  ).toEqual({ revision: 3 });
  const diff = (await env.DB.prepare(
    "SELECT id,status FROM event_artifacts WHERE event_id=? AND type='revision_diff' AND input_revision=2",
  )
    .bind(eventId)
    .first<{ id: number; status: string }>())!;
  expect(diff.status).toBe("pending_review");
  expect(
    await reviewArtifact(env.DB, {
      artifactId: diff.id,
      decision: "approved",
      expectedRevision: 2,
    }),
  ).toBe(true);
});

it("shows the revision created by rejecting an approved article", async () => {
  const eventId = await seedEvent(tech.industryId, "Event", 2);
  const kept = await seedArticle({ ...tech, title: "Kept report" });
  const withdrawn = await seedArticle({ ...tech, title: "Withdrawn report" });
  await seedEventArticle(eventId, kept, 1000, 1);
  await seedEventArticle(eventId, withdrawn, 2000, 2);
  await seedReview(kept, "approved");
  await seedReview(withdrawn, "approved");
  await decideReview(env.DB, {
    articleId: withdrawn,
    bodySha: "sha-current",
    decision: "rejected",
    reviewer: "admin",
  });
  expect(
    await env.DB.prepare("SELECT revision FROM events WHERE id=?")
      .bind(eventId)
      .first(),
  ).toEqual({ revision: 3 });
  await syncRevisionDiff(env.DB, eventId, 3, "published", 3000);
  expect(
    await env.DB.prepare(
      "SELECT status FROM event_artifacts WHERE event_id=? AND type='revision_diff' AND input_revision=3",
    )
      .bind(eventId)
      .first(),
  ).toEqual({ status: "published" });
  const view = (await getEvent(db(), eventId))!;
  expect(view.articles.map((a) => a.id)).toEqual([kept]);
  expect(view.timelineRevisions.some((r) => r.revision === 3)).toBe(true);
});

it("keeps a Finance primary document attached to its originating event after review", async () => {
  const { groupArticle } =
    await import("../../src/pipeline/group/group-article");
  const finance = (await env.DB.prepare(
    "SELECT i.id AS industryId,s.id AS sourceId FROM industries i JOIN sources s ON s.industry_id=i.id WHERE i.slug='finance'",
  ).first<{ industryId: number; sourceId: number }>())!;
  await env.DB.prepare(
    "UPDATE industries SET primary_domains='[\"sec.gov\"]' WHERE id=?",
  )
    .bind(finance.industryId)
    .run();
  const eventId = await seedEvent(finance.industryId, "Finance event", 1);
  const report = await seedArticle({
    ...finance,
    title: "Approved finance report",
  });
  await seedReview(report, "approved");
  await seedEventArticle(eventId, report, 1000, 1);
  const target = "https://sec.gov/Archives/filing";
  await env.BODIES.put(
    `bodies/${report}/sha-current.md`,
    `[Filing](${target})`,
  );
  const mockFetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes("robots.txt")
      ? new Response("User-agent: *\nAllow: /", { status: 200 })
      : new Response(
          "# Filing\n\n" +
            "The regulatory filing details measured annual results. ".repeat(
              10,
            ),
          { headers: { "Content-Type": "text/markdown" } },
        ),
  );
  await trackEventPrimarySources(
    { db: env.DB, bodies: env.BODIES, fetch: mockFetch },
    env,
    eventId,
    [],
    1000,
  );
  const filing = (await env.DB.prepare(
    "SELECT id,body_sha FROM articles WHERE canonical_url=?",
  )
    .bind(target)
    .first<{ id: number; body_sha: string }>())!;
  await decideReview(env.DB, {
    articleId: filing.id,
    bodySha: filing.body_sha,
    decision: "approved",
    reviewer: "admin",
  });
  await trackEventPrimarySources(
    { db: env.DB, bodies: env.BODIES, fetch: mockFetch },
    env,
    eventId,
    [],
    2000,
  );
  await groupArticle(
    {
      db: env.DB,
      now: () => 3_600_000,
      vectors: {
        query: async () => ({ matches: [], count: 0 }),
        upsert: async () => ({ mutationId: "test", ids: [], count: 0 }),
      },
      models: { embed: async () => [[1, 0]] } as never,
    },
    filing.id,
  );
  expect(
    await env.DB.prepare(
      "SELECT event_id FROM event_articles WHERE article_id=?",
    )
      .bind(filing.id)
      .first(),
  ).toEqual({ event_id: eventId });
});

it("does not classify an old cached vendor response as independent verification", async () => {
  const { generateEventEvidence } =
    await import("../../src/pipeline/evidence/build");
  const { createModelClient } = await import("../../src/providers/models");
  await env.DB.prepare("DELETE FROM llm_calls").run();
  await env.DB.prepare(
    "UPDATE industries SET primary_domains='[\"arxiv.org\"]',publish_mode='auto' WHERE id=?",
  )
    .bind(tech.industryId)
    .run();
  await env.DB.prepare("UPDATE sources SET site_domain='arxiv.org' WHERE id=?")
    .bind(tech.sourceId)
    .run();
  const eventId = await seedEvent(tech.industryId, "Event", 1);
  const article = await seedArticle({ ...tech, title: "Vendor paper" });
  await seedEventArticle(eventId, article, 1000, 1);
  await seedReview(article, "approved");
  const body =
    "Our model achieves a tenfold increase in throughput on this benchmark.";
  await env.BODIES.put(`bodies/${article}/sha-current.md`, body);
  const payload = JSON.stringify({
    eventId,
    inputRevision: 1,
    promptVersion: "claims:v1",
    articles: [
      {
        id: article,
        title: "Vendor paper",
        bodySha: "sha-current",
        sourceDomain: "arxiv.org",
        bodyExcerpt: body,
      },
    ],
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  const hash = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 16);
  const key = `evidence:${eventId}:claims:v1:1:${hash}`;
  const text = JSON.stringify({
    claims: [
      {
        claimText: "The vendor reports tenfold throughput",
        claimType: "fact",
        citations: [{ articleId: article, quote: body, stance: "support" }],
      },
    ],
  });
  const response = {
    usageMetadata: {
      promptTokenCount: 8,
      totalTokenCount: 10,
      candidatesTokenCount: 2,
    },
    candidates: [
      { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
    ],
  };
  await env.DB.prepare(
    "INSERT INTO llm_calls(logical_key,slot,model,channel,status,request_json,response_json,created_at,updated_at) VALUES(?,'reason','google/gemini-3.8-flash','gateway','completed','{}',?,1000,1000)",
  )
    .bind(key, JSON.stringify(response))
    .run();
  const transport = {
    run: vi.fn(async () => {
      throw new Error("unexpected model request");
    }),
  };
  const enabledEnv = { ...env, MODEL_CALLS_ENABLED: "true" };
  const models = createModelClient({ db: env.DB, env: enabledEnv, transport });
  const result = await generateEventEvidence(enabledEnv, eventId, 2000, {
    db: env.DB,
    bodies: env.BODIES,
    models,
  });
  expect(result.status).toBe("generated");
  expect(transport.run).not.toHaveBeenCalled();
  const claim = await env.DB.prepare(
    "SELECT reality_check FROM claims WHERE event_id=? AND claim_text NOT LIKE '[%]'",
  )
    .bind(eventId)
    .first();
  expect(claim).toEqual({ reality_check: "vendor_only" });
});

it("rejects attaching an article to an event in a different industry", async () => {
  const finance = (await env.DB.prepare(
    "SELECT i.id AS industryId,s.id AS sourceId FROM industries i JOIN sources s ON s.industry_id=i.id WHERE i.slug='finance'",
  ).first<{ industryId: number; sourceId: number }>())!;

  // Create an approved article in finance, in stage 'analyzed'
  const target = "https://sec.gov/filing-diff-ind";
  const financeArt = await seedArticle({
    industryId: finance.industryId,
    sourceId: finance.sourceId,
    title: "Finance filing",
    url: target,
  });
  await env.DB.prepare("UPDATE articles SET stage='analyzed' WHERE id=?")
    .bind(financeArt)
    .run();
  await seedReview(financeArt, "approved");

  // Create a tech event where article body mentions sec.gov filing
  await env.DB.prepare(
    "UPDATE industries SET primary_domains='[\"sec.gov\"]' WHERE id=?",
  )
    .bind(tech.industryId)
    .run();
  const techEventId = await seedEvent(tech.industryId, "Tech event", 1);
  const techReport = await seedArticle({ ...tech, title: "Tech report" });
  await seedEventArticle(techEventId, techReport, 1000, 1);
  await seedReview(techReport, "approved");
  await env.BODIES.put(
    `bodies/${techReport}/sha-current.md`,
    `[Filing](${target})`,
  );

  await trackEventPrimarySources(
    {
      db: env.DB,
      bodies: env.BODIES,
      fetch: vi.fn() as unknown as typeof fetch,
    },
    env,
    techEventId,
    [],
    1000,
  );

  // financeArt MUST NOT be attached to tech event
  const assigned = await env.DB.prepare(
    "SELECT event_id FROM event_articles WHERE article_id=?",
  )
    .bind(financeArt)
    .first();
  expect(assigned).toBeNull();

  // financeArt stage MUST remain 'analyzed'
  const artRow = await env.DB.prepare("SELECT stage FROM articles WHERE id=?")
    .bind(financeArt)
    .first<{ stage: string }>();
  expect(artRow?.stage).toBe("analyzed");
});

it("does not update article to grouped if event_articles insertion failed due to concurrent revision bump", async () => {
  const eventId = await seedEvent(tech.industryId, "Tech event", 1);
  const report = await seedArticle({ ...tech, title: "Tech report" });
  await seedEventArticle(eventId, report, 1000, 1);
  await seedReview(report, "approved");
  const target = "https://arxiv.org/abs/test-orphan";
  await env.BODIES.put(`bodies/${report}/sha-current.md`, `[Paper](${target})`);
  await env.DB.prepare(
    "UPDATE industries SET primary_domains='[\"arxiv.org\"]' WHERE id=?",
  )
    .bind(tech.industryId)
    .run();

  const mockArt = await seedArticle({
    ...tech,
    title: "Primary paper",
    url: target,
  });
  await env.DB.prepare("UPDATE articles SET stage='analyzed' WHERE id=?")
    .bind(mockArt)
    .run();
  await seedReview(mockArt, "approved");

  // Simulate concurrent bump: between read and batch, event revision is bumped from 1 to 2
  const dbWithConcurrentBump = {
    prepare: (sql: string) => env.DB.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      await env.DB.prepare(
        "UPDATE events SET revision = revision + 1 WHERE id = ?",
      )
        .bind(eventId)
        .run();
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;

  await trackEventPrimarySources(
    {
      db: dbWithConcurrentBump,
      bodies: env.BODIES,
      fetch: vi.fn() as unknown as typeof fetch,
    },
    env,
    eventId,
    [],
    1000,
  );

  // event_articles was NOT inserted because expected revision was 1
  const assigned = await env.DB.prepare(
    "SELECT event_id FROM event_articles WHERE article_id=?",
  )
    .bind(mockArt)
    .first();
  expect(assigned).toBeNull();

  // article MUST NOT be marked 'grouped' when it was not actually assigned
  const artRow = await env.DB.prepare("SELECT stage FROM articles WHERE id=?")
    .bind(mockArt)
    .first<{ stage: string }>();
  expect(artRow?.stage).toBe("analyzed");
});

it("attaches unapproved Finance primary document to originating event via groupArticle without model calls", async () => {
  const { groupArticle } =
    await import("../../src/pipeline/group/group-article");
  const finance = (await env.DB.prepare(
    "SELECT i.id AS industryId,s.id AS sourceId FROM industries i JOIN sources s ON s.industry_id=i.id WHERE i.slug='finance'",
  ).first<{ industryId: number; sourceId: number }>())!;

  const originEventId = await seedEvent(
    finance.industryId,
    "Finance Origin Event",
    1,
  );
  const targetUrl = "https://sec.gov/filing-origin-route";
  const filingArtId = await seedArticle({
    industryId: finance.industryId,
    sourceId: finance.sourceId,
    title: "Finance SEC Filing",
    url: targetUrl,
  });
  await env.DB.prepare("UPDATE articles SET stage='analyzed' WHERE id=?")
    .bind(filingArtId)
    .run();

  // Insert analysis with prompt_version='primary_tracker' and origin_event_id
  await env.DB.prepare(
    `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_pass, selected, created_at)
     VALUES (?1, 'primary_tracker', '{}', 'primary_source', ?2, 100, 1, 1, 1000)`,
  )
    .bind(
      filingArtId,
      JSON.stringify({
        kind: "primary_source",
        origin_event_id: originEventId,
      }),
    )
    .run();

  const mockEmbed = vi.fn();
  const mockJudge = vi.fn();
  const mockVectors = {
    query: vi.fn(),
    upsert: vi.fn(),
  };

  const res = await groupArticle(
    {
      db: env.DB,
      now: () => 1000,
      vectors: mockVectors,
      models: { embed: mockEmbed, judge: mockJudge } as never,
    },
    filingArtId,
  );

  expect(res.status).toBe("grouped");
  if (res.status === "grouped") {
    expect(res.eventId).toBe(originEventId);
  }

  // Model calls must NOT have been called:
  expect(mockEmbed).not.toHaveBeenCalled();
  expect(mockJudge).not.toHaveBeenCalled();
  expect(mockVectors.query).not.toHaveBeenCalled();

  // In unapproved state: input_revision equals current revision (1), and event revision does NOT bump:
  const ea = await env.DB.prepare(
    "SELECT event_id, input_revision FROM event_articles WHERE article_id=?",
  )
    .bind(filingArtId)
    .first<{ event_id: number; input_revision: number }>();
  expect(ea).toEqual({ event_id: originEventId, input_revision: 1 });

  const ev = await env.DB.prepare("SELECT revision FROM events WHERE id=?")
    .bind(originEventId)
    .first<{ revision: number }>();
  expect(ev?.revision).toBe(1);

  // Article stage is now 'grouped':
  const art = await env.DB.prepare("SELECT stage FROM articles WHERE id=?")
    .bind(filingArtId)
    .first<{ stage: string }>();
  expect(art?.stage).toBe("grouped");
});

it("falls back to standard grouping when origin_event_id belongs to a different industry", async () => {
  const { groupArticle } =
    await import("../../src/pipeline/group/group-article");
  const finance = (await env.DB.prepare(
    "SELECT i.id AS industryId,s.id AS sourceId FROM industries i JOIN sources s ON s.industry_id=i.id WHERE i.slug='finance'",
  ).first<{ industryId: number; sourceId: number }>())!;

  // Tech event in different industry:
  const techEventId = await seedEvent(tech.industryId, "Tech Event", 1);

  const filingArtId = await seedArticle({
    industryId: finance.industryId,
    sourceId: finance.sourceId,
    title: "Finance SEC Filing Mismatched Industry",
    url: "https://sec.gov/filing-mismatch",
  });
  await env.DB.prepare("UPDATE articles SET stage='analyzed' WHERE id=?")
    .bind(filingArtId)
    .run();

  // origin_event_id points to tech event (mismatched industry)
  await env.DB.prepare(
    `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, prefilter_pass, selected, created_at)
     VALUES (?1, 'primary_tracker', '{}', 'primary_source', ?2, 100, 1, 1, 1000)`,
  )
    .bind(
      filingArtId,
      JSON.stringify({ kind: "primary_source", origin_event_id: techEventId }),
    )
    .run();

  const mockEmbed = vi.fn(async () => [[0.1, 0.2]]);
  const mockVectors = {
    query: vi.fn(async () => ({ matches: [], count: 0 })),
    upsert: vi.fn(async () => ({ mutationId: "1", ids: [], count: 1 })),
  };

  const res = await groupArticle(
    {
      db: env.DB,
      now: () => 1000,
      vectors: mockVectors,
      models: { embed: mockEmbed } as never,
    },
    filingArtId,
  );

  // Fell back to normal grouping: embed was called, and created a new event in finance industry:
  expect(mockEmbed).toHaveBeenCalled();
  expect(res.status).toBe("grouped");
  if (res.status === "grouped") {
    expect(res.eventId).not.toBe(techEventId);
    const ev = await env.DB.prepare("SELECT industry_id FROM events WHERE id=?")
      .bind(res.eventId)
      .first<{ industry_id: number }>();
    expect(ev?.industry_id).toBe(finance.industryId);
  }
});
