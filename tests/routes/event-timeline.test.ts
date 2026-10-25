import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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
