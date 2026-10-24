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
       VALUES (?1, 'story_brief', '', 1, 'pv1', 'gemini', '{"whatHappened":"Old brief"}', 'published', 500)`,
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
});
