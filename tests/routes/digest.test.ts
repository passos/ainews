import { isNotFound } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadDigest } from "../../src/routes/digest/$section/$date";
import {
  getDigest,
  getRecentDigests,
} from "../../src/server/publication/digests";
import { digestFeedResponse } from "../../src/server/publication/feed";
import {
  db,
  DISCLAIMER,
  resetPublication,
  seedArticle,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

let tech: { industryId: number; sourceId: number };
let finance: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech, finance } = await seedSections());
});

describe("tests/routes/digest.test.ts", () => {
  it("review section: unapproved digest (published_at is null) throws notFound and does not appear in RSS; appears after publish", async () => {
    const eventId = await seedEvent(tech.industryId, "Tech Event 1", 0);
    const artId = await seedArticle({
      ...tech,
      title: "Tech Article 1",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, artId, 1000);
    await seedReview(artId, "approved");

    const itemsJson = JSON.stringify([
      {
        eventId,
        title: "Tech Event 1",
        oneLiner: "Major tech development.",
        sourceName: "Tech Wire",
        articleCount: 1,
      },
    ]);

    // Insert unpublished digest (published_at = NULL)
    const insRes = await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', 'Daily summary', ?2, 1000, NULL) RETURNING id`,
    )
      .bind(tech.industryId, itemsJson)
      .first<{ id: number }>();

    const digestId = insRes!.id;

    // 1. Unapproved digest page should throw notFound (404)
    await expect(
      loadDigest(
        { section: "technology", date: "2026-10-21" },
        {
          getDigest: (slug, date) => getDigest(db(), slug, date),
          getRecentDigests: (slug) => getRecentDigests(db(), slug),
        },
      ),
    ).rejects.toSatisfy(isNotFound);

    // 2. Not in RSS
    const rssResBefore = await digestFeedResponse(
      db(),
      "https://news.ioenv.com",
      "technology",
    );
    expect(rssResBefore.status).toBe(200);
    const rssXmlBefore = await rssResBefore.text();
    expect(rssXmlBefore).not.toContain("2026-10-21");

    // 3. Admin approves/publishes digest
    await env.DB.prepare("UPDATE digests SET published_at = 2000 WHERE id = ?1")
      .bind(digestId)
      .run();

    // 4. Now loader returns digest data
    const resultAfter = await loadDigest(
      { section: "technology", date: "2026-10-21" },
      {
        getDigest: (slug, date) => getDigest(db(), slug, date),
        getRecentDigests: (slug) => getRecentDigests(db(), slug),
      },
    );

    expect(resultAfter.data).toBeDefined();
    expect(resultAfter.data.periodStart).toBe("2026-10-21");
    expect(resultAfter.data.intro).toBe("Daily summary");
    expect(resultAfter.data.items).toHaveLength(1);
    expect(resultAfter.data.items[0].oneLiner).toBe("Major tech development.");

    // 5. Appears in RSS
    const rssResAfter = await digestFeedResponse(
      db(),
      "https://news.ioenv.com",
      "technology",
    );
    const rssXmlAfter = await rssResAfter.text();
    expect(rssXmlAfter).toContain("Daily Digest — 2026-10-21");
    expect(rssXmlAfter).toContain("Major tech development.");
  });

  it("Finance digest page and RSS include section disclaimer", async () => {
    const eventId = await seedEvent(finance.industryId, "Market Event", 0);
    const artId = await seedArticle({
      ...finance,
      title: "Market Article",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, artId, 1000);
    await seedReview(artId, "approved");

    const itemsJson = JSON.stringify([
      {
        eventId,
        title: "Market Event",
        oneLiner: "Fed announcement.",
        sourceName: "Finance Wire",
        articleCount: 1,
      },
    ]);

    await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', 'Finance summary', ?2, 1000, 1000)`,
    )
      .bind(finance.industryId, itemsJson)
      .run();

    const result = await loadDigest(
      { section: "finance", date: "2026-10-21" },
      {
        getDigest: (slug, date) => getDigest(db(), slug, date),
        getRecentDigests: (slug) => getRecentDigests(db(), slug),
      },
    );

    expect(result.data.section.disclaimer).toBe(DISCLAIMER);

    const rssRes = await digestFeedResponse(
      db(),
      "https://news.ioenv.com",
      "finance",
    );
    const rssXml = await rssRes.text();
    expect(rssXml).toContain(DISCLAIMER);
  });

  it("item whose event articles are subsequently rejected is not shown on the public digest page", async () => {
    const eventId1 = await seedEvent(tech.industryId, "Kept Event", 0);
    const artId1 = await seedArticle({
      ...tech,
      title: "Kept Article",
      bodySha: "sha1",
    });
    await seedEventArticle(eventId1, artId1, 1000);
    await seedReview(artId1, "approved", "sha1");

    const eventId2 = await seedEvent(tech.industryId, "Takedown Event", 0);
    const artId2 = await seedArticle({
      ...tech,
      title: "Takedown Article",
      bodySha: "sha2",
    });
    await seedEventArticle(eventId2, artId2, 2000);
    await seedReview(artId2, "approved", "sha2");

    const itemsJson = JSON.stringify([
      {
        eventId: eventId1,
        title: "Kept Event",
        oneLiner: "Still valid story.",
        sourceName: "Tech Wire",
        articleCount: 1,
      },
      {
        eventId: eventId2,
        title: "Takedown Event",
        oneLiner: "Discredited story.",
        sourceName: "Tech Wire",
        articleCount: 1,
      },
    ]);

    await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', 'Summary', ?2, 1000, 1000)`,
    )
      .bind(tech.industryId, itemsJson)
      .run();

    // Later, artId2 is rejected
    await seedReview(artId2, "rejected", "sha2");

    const result = await loadDigest(
      { section: "technology", date: "2026-10-21" },
      {
        getDigest: (slug, date) => getDigest(db(), slug, date),
        getRecentDigests: (slug) => getRecentDigests(db(), slug),
      },
    );

    // Only kept event remains on web; intro is suppressed because 1 item was retracted
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].eventId).toBe(eventId1);
    expect(result.data.items[0].title).toBe("Kept Article");
    expect(result.data.intro).toBe("");

    // RSS feed also removes the retracted item and suppresses retracted intro
    const rssRes = await digestFeedResponse(
      db(),
      "https://news.ioenv.com",
      "technology",
    );
    const rssXml = await rssRes.text();
    expect(rssXml).toContain("Still valid story.");
    expect(rssXml).not.toContain("Discredited story.");
    expect(rssXml).not.toContain("Summary");

    // If kept article is also rejected (0 surviving items left)
    await seedReview(artId1, "rejected", "sha1");
    await expect(
      loadDigest(
        { section: "technology", date: "2026-10-21" },
        {
          getDigest: (slug, date) => getDigest(db(), slug, date),
          getRecentDigests: (slug) => getRecentDigests(db(), slug),
        },
      ),
    ).rejects.toSatisfy(isNotFound);

    const rssResEmpty = await digestFeedResponse(
      db(),
      "https://news.ioenv.com",
      "technology",
    );
    const rssXmlEmpty = await rssResEmpty.text();
    expect(rssXmlEmpty).not.toContain("Daily Digest — 2026-10-21");
  });

  it("multi-article event: retracting one article bumps revision, suppresses digest intro, and replaces oneLiner with surviving article summary", async () => {
    const eventId = await seedEvent(tech.industryId, "Original Event Title", 0);

    const artId1 = await seedArticle({
      ...tech,
      title: "Article 1 (Retracted Later)",
      summary: "Summary 1 that was retracted",
      bodySha: "sha-1",
      publishedAt: 1000,
    });
    const artId2 = await seedArticle({
      ...tech,
      title: "Article 2 (Surviving)",
      summary: "Surviving article summary",
      bodySha: "sha-2",
      publishedAt: 2000,
    });
    await seedEventArticle(eventId, artId1, 1000);
    await seedEventArticle(eventId, artId2, 2000);
    await seedReview(artId1, "approved", "sha-1");
    await seedReview(artId2, "approved", "sha-2");

    const itemsJson = JSON.stringify([
      {
        eventId,
        eventRevision: 0,
        title: "Original Event Title",
        oneLiner: "Old synthesized one-liner mentioning Article 1 claims.",
        sourceName: "Tech Wire",
        articleCount: 2,
      },
    ]);

    await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-22', 'UTC', 'ready', 'Synthesized editorial intro mentioning retracted claims.', ?2, 1000, 1000)`,
    )
      .bind(tech.industryId, itemsJson)
      .run();

    // Now retract Article 1, bumping event revision and marking review rejected
    await seedReview(artId1, "rejected", "sha-1");
    await env.DB.prepare(
      "UPDATE events SET revision = revision + 1 WHERE id = ?1",
    )
      .bind(eventId)
      .run();

    const result = await loadDigest(
      { section: "technology", date: "2026-10-22" },
      {
        getDigest: (slug, date) => getDigest(db(), slug, date),
        getRecentDigests: (slug) => getRecentDigests(db(), slug),
      },
    );

    // Event still survives (1 article left)
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].eventId).toBe(eventId);
    // Intro must be suppressed to empty string
    expect(result.data.intro).toBe("");
    // One-liner must be replaced with surviving summary, NOT the old one-liner
    expect(result.data.items[0].oneLiner).toBe("Surviving article summary");
    expect(result.data.items[0].oneLiner).not.toContain(
      "Old synthesized one-liner",
    );

    // RSS feed also suppresses intro and outputs surviving summary
    const rssRes = await digestFeedResponse(
      db(),
      "https://news.ioenv.com",
      "technology",
    );
    const rssXml = await rssRes.text();
    expect(rssXml).not.toContain(
      "Synthesized editorial intro mentioning retracted claims.",
    );
    expect(rssXml).not.toContain(
      "Old synthesized one-liner mentioning Article 1 claims.",
    );
    expect(rssXml).toContain("Surviving article summary");
  });

  it("invalid date or nonexistent section throws notFound", async () => {
    await expect(
      loadDigest(
        { section: "technology", date: "not-a-date" },
        {
          getDigest: (slug, date) => getDigest(db(), slug, date),
          getRecentDigests: (slug) => getRecentDigests(db(), slug),
        },
      ),
    ).rejects.toSatisfy(isNotFound);

    await expect(
      loadDigest(
        { section: "nonexistent", date: "2026-10-21" },
        {
          getDigest: (slug, date) => getDigest(db(), slug, date),
          getRecentDigests: (slug) => getRecentDigests(db(), slug),
        },
      ),
    ).rejects.toSatisfy(isNotFound);
  });
});
