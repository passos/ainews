import { env } from "cloudflare:workers";
import { isNotFound } from "@tanstack/react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { loadEvent } from "../../src/routes/e/$eventId";
import { getEvent, getEventSources } from "../../src/server/publication/events";
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

describe("tests/routes/event.test.ts", () => {
  it("event with 1 approved + 1 pending article: loader returns only approved article and title from it", async () => {
    const eventId = await seedEvent(
      tech.industryId,
      "Raw Model Event Title",
      0,
    );

    const artApproved = await seedArticle({
      ...tech,
      title: "Approved Article Title",
      publishedAt: 1000,
    });
    const artPending = await seedArticle({
      ...tech,
      title: "Pending Article Title",
      publishedAt: 2000,
    });

    await seedEventArticle(eventId, artApproved, 1000);
    await seedEventArticle(eventId, artPending, 2000);

    await seedReview(artApproved, "approved");

    const result = await loadEvent(
      { eventId: String(eventId) },
      {
        getEvent: (id) => getEvent(db(), id),
        getEventSources: (id) => getEventSources(db(), id),
      },
    );

    expect(result.data).toBeDefined();
    expect(result.data.title).toBe("Approved Article Title");
    expect(result.data.articles.length).toBe(1);
    expect(result.data.articles[0].id).toBe(artApproved);
  });

  it("event with only pending articles throws notFound (404)", async () => {
    const eventId = await seedEvent(tech.industryId, "Pending Only Event", 0);

    const artPending = await seedArticle({
      ...tech,
      title: "Pending Article Title",
      publishedAt: 1000,
    });

    await seedEventArticle(eventId, artPending, 1000);
    // No review approval

    let caught: unknown = null;
    try {
      await loadEvent(
        { eventId: String(eventId) },
        {
          getEvent: (id) => getEvent(db(), id),
          getEventSources: (id) => getEventSources(db(), id),
        },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(isNotFound(caught)).toBe(true);
  });

  it("invalid eventId throws notFound (404)", async () => {
    let caught: unknown = null;
    try {
      await loadEvent({ eventId: "not-a-number" });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(isNotFound(caught)).toBe(true);
  });

  it("loads published artifacts matching current revision and excludes pending or stale revisions", async () => {
    const eventId = await seedEvent(
      tech.industryId,
      "Artifact Test Event",
      2, // Current revision is 2
    );

    const art = await seedArticle({
      ...tech,
      title: "Art Article",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, art, 1000);
    await seedReview(art, "approved");

    // 1. Published artifact matching revision 2 (Story Brief)
    await env.DB.prepare(
      `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
       VALUES (?1, 'story_brief', '', 2, 'pv1', 'gemini', '{"whatHappened":"Verified event","whatIsNew":"New milestone","whatEvidenceExists":"Bench test","whatToWatchNext":"Next quarter"}', 'published', 1000)`,
    )
      .bind(eventId)
      .run();

    // 2. Published artifact matching revision 2 (Audience Explain)
    await env.DB.prepare(
      `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
       VALUES (?1, 'audience_explain', 'student', 2, 'pv1', 'gemini', '{"audience":"student","overview":"Simple explainer","keyPoints":["Point 1"],"implications":["Imp 1"],"glossary":[{"term":"T1","definition":"D1"}]}', 'published', 1000)`,
    )
      .bind(eventId)
      .run();

    // 3. Pending review artifact (should be excluded)
    await env.DB.prepare(
      `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
       VALUES (?1, 'audience_explain', 'educator', 2, 'pv1', 'gemini', '{"audience":"educator","overview":"Pending","keyPoints":["Valid point"],"implications":["Valid imp"],"glossary":[]}', 'pending_review', 1000)`,
    )
      .bind(eventId)
      .run();

    // 4. Stale revision artifact matching revision 1 (should be excluded)
    await env.DB.prepare(
      `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
       VALUES (?1, 'research_paper_decoder', '', 1, 'pv1', 'gemini', '{"hypothesis":"Old hyp","method":"Old met","findings":"Old find","limitations":"Old lim","applications":"Old app"}', 'published', 500)`,
    )
      .bind(eventId)
      .run();

    const result = await loadEvent(
      { eventId: String(eventId) },
      {
        getEvent: (id) => getEvent(db(), id),
        getEventSources: (id) => getEventSources(db(), id),
      },
    );

    expect(result.data.artifacts).toBeDefined();
    expect(result.data.artifacts.brief).toEqual({
      whatHappened: "Verified event",
      whatIsNew: "New milestone",
      whatEvidenceExists: "Bench test",
      whatToWatchNext: "Next quarter",
    });
    expect(result.data.artifacts.explanations.student).toBeDefined();
    expect(result.data.artifacts.explanations.student?.overview).toBe(
      "Simple explainer",
    );
    // Educator is pending_review -> must not be present
    expect(result.data.artifacts.explanations.educator).toBeUndefined();
    // Decoder was never generated -> null
    expect(result.data.artifacts.decoder).toBeNull();
  });

  it("loads published claims and verified citations for current revision; excludes pending, stale revisions, and unverified citations", async () => {
    const eventId = await seedEvent(
      tech.industryId,
      "Evidence Test Event",
      2, // Current revision is 2
    );

    const art = await seedArticle({
      ...tech,
      title: "Evidence Article",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, art, 1000);
    await seedReview(art, "approved");

    // Fetch article's body_sha
    const artRow = await env.DB.prepare(
      "SELECT body_sha FROM articles WHERE id = ?1",
    )
      .bind(art)
      .first<{ body_sha: string }>();
    const bodySha = artRow!.body_sha;

    // 1. Published Claim matching revision 2
    const res1 = await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 2, 'pv1', 'gemini', 'Verified high-level claim', 'fact', 'verified', 'published', 1, 1000)
       RETURNING id`,
    )
      .bind(eventId)
      .first<{ id: number }>();
    const claim1Id = res1!.id;

    // 1a. Verified citation on Claim 1 (should be included)
    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, stance, quote, quote_clean, start_offset, end_offset, verified, is_primary_source, created_at)
       VALUES (?1, ?2, ?3, 'support', 'Verbatim evidence quote from approved body.', 'Verbatim evidence quote from approved body.', 10, 55, 1, 1, 1000)`,
    )
      .bind(claim1Id, art, bodySha)
      .run();

    // 1b. Unverified citation on Claim 1 (verified = 0, should be excluded)
    await env.DB.prepare(
      `INSERT INTO claim_evidence (claim_id, article_id, body_sha, stance, quote, quote_clean, start_offset, end_offset, verified, is_primary_source, created_at)
       VALUES (?1, ?2, ?3, 'dispute', 'Unverified quote not matching text.', 'Unverified quote not matching text.', 0, 0, 0, 0, 1000)`,
    )
      .bind(claim1Id, art, bodySha)
      .run();

    // 2. Pending review Claim (should be excluded)
    await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 2, 'pv1', 'gemini', 'Pending unapproved claim', 'interpretation', 'unverified', 'pending_review', 0, 1000)`,
    )
      .bind(eventId)
      .run();

    // 3. Stale Claim matching revision 1 (should be excluded)
    await env.DB.prepare(
      `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
       VALUES (?1, 1, 'pv1', 'gemini', 'Stale revision claim', 'prediction', 'verified', 'published', 0, 500)`,
    )
      .bind(eventId)
      .run();

    const result = await loadEvent(
      { eventId: String(eventId) },
      {
        getEvent: (id) => getEvent(db(), id),
        getEventSources: (id) => getEventSources(db(), id),
      },
    );

    expect(result.data.evidence).toBeDefined();
    expect(result.data.evidence.claims.length).toBe(1);

    const claim = result.data.evidence.claims[0];
    expect(claim.claimText).toBe("Verified high-level claim");
    expect(claim.claimType).toBe("fact");
    expect(claim.consensusStatus).toBe("verified");
    expect(claim.primarySourcePreferred).toBe(true);

    // Citations: only verified=1 citation should be returned
    expect(claim.evidence.length).toBe(1);
    expect(claim.evidence[0].quote).toBe(
      "Verbatim evidence quote from approved body.",
    );
    expect(claim.evidence[0].verified).toBe(true);
    expect(claim.evidence[0].isPrimarySource).toBe(true);
  });
});
