import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEvent } from "../../src/server/publication/events";
import {
  db,
  resetPublication,
  seedArticle,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

let tech: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
});

describe("tests/routes/event-timeline.test.ts", () => {
  it("getEvent returns timelineRevisions with revision diffs, grouped articles, and reality check claims", async () => {
    // 1. Setup event at revision 2
    const eventId = await seedEvent(
      tech.industryId,
      "AI Reasoning Model Breakthrough",
      2,
    );

    // 2. Article 1 (Vendor) in revision 1
    const art1 = await seedArticle({
      ...tech,
      title: "Vendor Releases New Frontier Model",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, art1, 1000, 1);
    await seedReview(art1, "approved");

    // 3. Article 2 (Independent preprint) in revision 2
    const art2 = await seedArticle({
      ...tech,
      title: "Independent Benchmark Evaluation on Frontier Model",
      publishedAt: 2000,
    });
    await seedEventArticle(eventId, art2, 2000, 2);
    await seedReview(art2, "approved");

    // Mark art2 with preprint evidence
    await env.DB.prepare(
      `INSERT INTO analyses (article_id, prompt_version, scores, content_type, evidence_tags, total_score, created_at, prefilter_pass, selected)
       VALUES (?1, 'v1', '{}', 'news', '{"source":"preprint"}', 80, 2000, 1, 1)`,
    )
      .bind(art2)
      .run();

    // 4. Seed revision diff artifacts
    await env.DB.prepare(
      `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
       VALUES (?1, 'revision_diff', '', 1, 'diff-v1', 'deterministic', ?2, 'published', 1000),
              (?1, 'revision_diff', '', 2, 'diff-v1', 'deterministic', ?3, 'published', 2000)`,
    )
      .bind(
        eventId,
        JSON.stringify({
          revision: 1,
          summary: "Initial report based on Vendor press release.",
          newSources: ["Tech Wire"],
          newClaims: ["Model claims 10x throughput"],
          changedClaims: [],
        }),
        JSON.stringify({
          revision: 2,
          summary:
            "New claims identified from arXiv cs.AI: Latency regressions under load.",
          newSources: ["arXiv cs.AI"],
          newClaims: ["Latency regressions under load"],
          changedClaims: [
            "Model claims 10x throughput (vendor_only → independent_disputed)",
          ],
        }),
      )
      .run();

    // 5. Seed claims with Reality Check and citations with source roles
    const claimRes = await env.DB.prepare(
      `INSERT INTO claims (event_id, claim_text, claim_type, consensus_status, primary_source_preferred, reality_check, status, input_revision, prompt_version, model, created_at)
       VALUES (?1, 'Model claims 10x throughput', 'fact', 'disputed', 1, 'independent_disputed', 'published', 2, 'v1', 'mock', 2000)
       RETURNING id`,
    )
      .bind(eventId)
      .first<{ id: number }>();
    const claimId = claimRes!.id;

    // Vendor citation
    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, quote, quote_clean, start_offset, end_offset, stance, is_primary_source, source_role, verified, created_at)
       VALUES (?1, ?2, 'sha-current', 'We report a ten-fold increase in throughput on standard benchmarks.', 'clean', 10, 80, 'support', 0, 'vendor', 1, 2000)`,
    )
      .bind(claimId, art1)
      .run();

    // Independent citation
    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, quote, quote_clean, start_offset, end_offset, stance, is_primary_source, source_role, verified, created_at)
       VALUES (?1, ?2, 'sha-current', 'Our evaluations dispute the throughput claims when context exceeds 4k.', 'clean', 20, 95, 'dispute', 1, 'independent', 1, 2000)`,
    )
      .bind(claimId, art2)
      .run();

    // 6. Call getEvent
    const view = await getEvent(db(), eventId);
    expect(view).not.toBeNull();
    expect(view!.title).toBe("Vendor Releases New Frontier Model");
    expect(view!.articles.length).toBe(2);

    // Verify timeline revisions
    expect(view!.timelineRevisions).toBeDefined();
    expect(view!.timelineRevisions.length).toBe(2);

    const rev1 = view!.timelineRevisions.find((r) => r.revision === 1);
    expect(rev1).toBeDefined();
    expect(rev1!.diff?.summary).toContain("Initial report");
    expect(rev1!.articles.length).toBe(1);
    expect(rev1!.articles[0].id).toBe(art1);

    const rev2 = view!.timelineRevisions.find((r) => r.revision === 2);
    expect(rev2).toBeDefined();
    expect(rev2!.diff?.summary).toContain("New claims identified");
    expect(rev2!.diff?.changedClaims).toEqual([
      "Model claims 10x throughput (vendor_only → independent_disputed)",
    ]);
    expect(rev2!.articles.length).toBe(1);
    expect(rev2!.articles[0].id).toBe(art2);
    expect(rev2!.articles[0].evidence).toContain("preprint");

    // Verify reality check and source roles in evidence view
    expect(view!.evidence.claims.length).toBe(1);
    const claim = view!.evidence.claims[0];
    expect(claim.realityCheck).toBe("independent_disputed");
    expect(claim.evidence.length).toBe(2);

    const vendorCit = claim.evidence.find((e) => e.sourceRole === "vendor");
    expect(vendorCit).toBeDefined();
    expect(vendorCit?.articleId).toBe(art1);

    const indCit = claim.evidence.find((e) => e.sourceRole === "independent");
    expect(indCit).toBeDefined();
    expect(indCit?.articleId).toBe(art2);
    expect(indCit?.isPrimarySource).toBe(true);
  });
});

it("independent review: withdrawal removes derived claims from historical timeline", async () => {
  const { syncRevisionDiff } = await import("../../src/pipeline/evidence/diff");
  const { decideReview } = await import("../../src/server/admin/ops");
  const eventId = await seedEvent(tech.industryId, "An event", 2);
  const kept = await seedArticle({
    ...tech,
    title: "Still approved reporting",
  });
  const withdrawn = await seedArticle({
    ...tech,
    title: "Withdrawn sole evidence",
  });
  await seedEventArticle(eventId, kept, 1000, 1);
  await seedEventArticle(eventId, withdrawn, 2000, 2);
  await seedReview(kept, "approved");
  await seedReview(withdrawn, "approved");
  const claim = (await env.DB.prepare(
    "INSERT INTO claims(event_id,claim_text,claim_type,consensus_status,status,input_revision,prompt_version,model,created_at) VALUES(?,'Withdrawn unsupported result','fact','verified','published',2,'v1','mock',2000) RETURNING id",
  )
    .bind(eventId)
    .first<{ id: number }>())!;
  await env.DB.prepare(
    "INSERT INTO claim_evidence(claim_id,article_id,body_sha,quote,quote_clean,start_offset,end_offset,stance,verified,created_at) VALUES(?,?,'sha-current','Withdrawn unsupported result','Withdrawn unsupported result',0,27,'support',1,2000)",
  )
    .bind(claim.id, withdrawn)
    .run();
  await syncRevisionDiff(env.DB, eventId, 2, "published", 2000);
  await decideReview(env.DB, {
    articleId: withdrawn,
    bodySha: "sha-current",
    decision: "rejected",
    reviewer: "admin",
  });
  const view = await getEvent(db(), eventId);
  expect(view).not.toBeNull();
  expect(view!.articles.map((a) => a.id)).toEqual([kept]);
  expect(view!.evidence.claims).toEqual([]);
  expect(
    view!.timelineRevisions.map((r) => r.diff?.summary).join(" "),
  ).not.toContain("Withdrawn unsupported result");
});

it("independent review: hides a withdrawn article's claim even when another article preserves the diff revision", async () => {
  const { syncRevisionDiff } = await import("../../src/pipeline/evidence/diff");
  const { decideReview } = await import("../../src/server/admin/ops");
  const eventId = await seedEvent(tech.industryId, "Event", 2);
  const withdrawn = await seedArticle({ ...tech, title: "Withdrawn evidence" });
  const kept = await seedArticle({ ...tech, title: "Still approved" });
  await seedEventArticle(eventId, withdrawn, 1000, 1);
  await seedEventArticle(eventId, kept, 2000, 2);
  await seedReview(withdrawn, "approved");
  await seedReview(kept, "approved");
  const claim = (await env.DB.prepare(
    "INSERT INTO claims(event_id,claim_text,claim_type,consensus_status,status,input_revision,prompt_version,model,created_at) VALUES(?,'Withdrawn unsupported result','fact','verified','published',2,'v1','mock',2000) RETURNING id",
  )
    .bind(eventId)
    .first<{ id: number }>())!;
  await env.DB.prepare(
    "INSERT INTO claim_evidence(claim_id,article_id,body_sha,quote,quote_clean,start_offset,end_offset,stance,verified,created_at) VALUES(?,?,'sha-current','Withdrawn unsupported result','Withdrawn unsupported result',0,27,'support',1,2000)",
  )
    .bind(claim.id, withdrawn)
    .run();
  await syncRevisionDiff(env.DB, eventId, 2, "published", 2000);
  await decideReview(env.DB, {
    articleId: withdrawn,
    bodySha: "sha-current",
    decision: "rejected",
    reviewer: "admin",
  });
  const view = await getEvent(db(), eventId);
  expect(view!.articles.map((a) => a.id)).toEqual([kept]);
  expect(JSON.stringify(view!.timelineRevisions)).not.toContain(
    "Withdrawn unsupported result",
  );
});

it("independent review: withdrawal removes changed claims whose own text contains parentheses", async () => {
  const { syncRevisionDiff } = await import("../../src/pipeline/evidence/diff");
  const { decideReview } = await import("../../src/server/admin/ops");
  const eventId = await seedEvent(tech.industryId, "Event", 2);
  const withdrawn = await seedArticle({ ...tech, title: "Withdrawn evidence" });
  const kept = await seedArticle({ ...tech, title: "Still approved" });
  await seedEventArticle(eventId, withdrawn, 1000, 1);
  await seedEventArticle(eventId, kept, 2000, 2);
  await seedReview(withdrawn, "approved");
  await seedReview(kept, "approved");
  const text = "Throughput (tokens/sec) increased";
  for (const [revision, reality] of [
    [1, "vendor_only"],
    [2, "independent_verified"],
  ] as const) {
    const claim = await env.DB.prepare(
      `INSERT INTO claims(event_id,claim_text,claim_type,consensus_status,reality_check,status,input_revision,prompt_version,model,created_at)
       VALUES(?,?,'fact','verified',?,'published',?,'v1','mock',2000) RETURNING id`,
    )
      .bind(eventId, text, reality, revision)
      .first<{ id: number }>();
    await env.DB.prepare(
      `INSERT INTO claim_evidence(claim_id,article_id,body_sha,quote,quote_clean,start_offset,end_offset,stance,verified,created_at)
       VALUES(?,?,'sha-current',?,?,0,32,'support',1,2000)`,
    )
      .bind(claim!.id, withdrawn, text, text)
      .run();
  }
  await syncRevisionDiff(env.DB, eventId, 2, "published", 2000);
  const before = await getEvent(db(), eventId);
  expect(
    before!.timelineRevisions.find((r) => r.revision === 2)!.diff!
      .changedClaims,
  ).toEqual([`${text} (vendor_only → independent_verified)`]);
  await decideReview(env.DB, {
    articleId: withdrawn,
    bodySha: "sha-current",
    decision: "rejected",
    reviewer: "admin",
  });
  const after = await getEvent(db(), eventId);
  expect(after!.articles.map((a) => a.id)).toEqual([kept]);
  expect(JSON.stringify(after!.timelineRevisions)).not.toContain(text);
});

it("independent review: creates a diff for each revision when two primary sources are tracked before the queue drains", async () => {
  const { trackEventPrimarySources } =
    await import("../../src/pipeline/evidence/primary");
  const { generateEventArtifacts } =
    await import("../../src/pipeline/artifacts/build");
  const { syncRevisionDiff } = await import("../../src/pipeline/evidence/diff");
  type PipelineEnv = import("../../src/pipeline/messages").PipelineEnv;
  type ModelClient = import("../../src/providers/models").ModelClient;

  await env.DB.prepare(
    "UPDATE industries SET publish_mode='auto',primary_domains='[\"arxiv.org\",\"whitehouse.gov\"]' WHERE id=?",
  )
    .bind(tech.industryId)
    .run();
  const eventId = await seedEvent(tech.industryId, "Event", 1);
  const article = await seedArticle({ ...tech, title: "Original reporting" });
  await seedEventArticle(eventId, article, 1000, 1);
  await seedReview(article, "approved");
  await env.BODIES.put(
    `bodies/${article}/sha-current.md`,
    "[Paper](https://arxiv.org/abs/review-new) [Release](https://whitehouse.gov/review-new)",
  );
  await syncRevisionDiff(env.DB, eventId, 1, "published", 1000);
  const messages: Array<{ eventId: number; kind: string }> = [];
  const queue = {
    send: async (m: unknown) => {
      messages.push(m as { eventId: number; kind: string });
    },
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("robots.txt"))
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    return new Response(
      "# Primary publication\n\n" +
        "This public document reports original research with detailed measurements and supporting experimental evidence. ".repeat(
          5,
        ),
      { status: 200, headers: { "Content-Type": "text/markdown" } },
    );
  });
  const tracked = await trackEventPrimarySources(
    { db: env.DB, bodies: env.BODIES, fetch: fetchMock, qArtifacts: queue },
    env,
    eventId,
    [],
    1000,
  );
  expect(tracked.trackedCount).toBe(2);
  expect(
    await env.DB.prepare("SELECT revision FROM events WHERE id=?")
      .bind(eventId)
      .first(),
  ).toEqual({ revision: 3 });
  expect(messages).toHaveLength(2);
  const models = {
    generateText: vi.fn(async (_slot: string, key: string) => {
      let value: unknown;
      if (key.includes(":story_brief:")) {
        value = {
          whatHappened: "Original results",
          whatIsNew: "Two primary sources",
          whatEvidenceExists: "Published documents",
          whatToWatchNext: "Independent evaluation",
        };
      } else if (key.includes(":audience_explain:")) {
        const audience = key.split(":")[3];
        value = {
          audience,
          overview: "Original results",
          keyPoints: ["Two sources"],
          implications: ["More evidence"],
          glossary: [],
        };
      } else {
        value = {
          hypothesis: "Original results",
          method: "Experiment",
          findings: "Measured results",
          limitations: "Small sample",
          applications: "Further research",
        };
      }
      return { text: JSON.stringify(value), finishReason: "STOP" };
    }),
  } as unknown as ModelClient;
  for (const message of messages) {
    await generateEventArtifacts(env as PipelineEnv, message.eventId, 2000, {
      db: env.DB,
      bodies: env.BODIES,
      models,
    });
  }
  const view = (await getEvent(db(), eventId))!;
  expect(view.timelineRevisions.map((r) => r.revision)).toEqual([1, 2, 3]);
  expect(
    view.timelineRevisions.find((r) => r.revision === 3)!.diff,
  ).not.toBeNull();
  expect(
    view.timelineRevisions.find((r) => r.revision === 2)!.diff,
  ).not.toBeNull();
});
