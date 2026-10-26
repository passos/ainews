import { isNotFound } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SITE_NAME } from "../../src/lib/site";
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
  it("unpublished digest (published_at is null) throws notFound and does not appear in RSS; appears after publish", async () => {
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
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at, copy_approved_at)
       VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', 'Daily summary', ?2, 1000, NULL, 1000) RETURNING id`,
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
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at, copy_approved_at)
       VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', 'Summary', ?2, 1000, 1000, 1000)`,
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
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at, copy_approved_at)
       VALUES (?1, 'daily', '2026-10-22', 'UTC', 'ready', 'Synthesized editorial intro mentioning retracted claims.', ?2, 1000, 1000, 1000)`,
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

  it("weekly digest: unapproved throws notFound; after publish, loads with kind = 'weekly' and renders in RSS with ?kind=weekly", async () => {
    const eventId = await seedEvent(tech.industryId, "Weekly Tech Event", 0);
    const artId = await seedArticle({
      ...tech,
      title: "Weekly Tech Article",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, artId, 1000);
    await seedReview(artId, "approved");

    const itemsJson = JSON.stringify([
      {
        eventId,
        title: "Weekly Tech Event",
        oneLiner: "Key weekly technology trend.",
        sourceName: "Tech Weekly",
        articleCount: 1,
      },
    ]);

    // Insert unpublished weekly digest
    const insRes = await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at, copy_approved_at)
       VALUES (?1, 'weekly', '2026-10-19', 'UTC', 'ready', 'Weekly overview narrative', ?2, 1000, NULL, 1000) RETURNING id`,
    )
      .bind(tech.industryId, itemsJson)
      .first<{ id: number }>();

    const digestId = insRes!.id;

    // Unapproved weekly digest throws notFound
    await expect(
      loadDigest({ section: "technology", date: "2026-10-19" }, "weekly", {
        getDigest: (slug, date, kind) => getDigest(db(), slug, date, kind),
        getRecentDigests: (slug, kind) => getRecentDigests(db(), slug, 7, kind),
      }),
    ).rejects.toSatisfy(isNotFound);

    // Publish weekly digest
    await env.DB.prepare("UPDATE digests SET published_at = 2000 WHERE id = ?1")
      .bind(digestId)
      .run();

    // Now loads successfully
    const result = await loadDigest(
      { section: "technology", date: "2026-10-19" },
      "weekly",
      {
        getDigest: (slug, date, kind) => getDigest(db(), slug, date, kind),
        getRecentDigests: (slug, kind) => getRecentDigests(db(), slug, 7, kind),
      },
    );

    expect(result.data.kind).toBe("weekly");
    expect(result.data.periodStart).toBe("2026-10-19");
    expect(result.data.intro).toBe("Weekly overview narrative");
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].title).toBe("Weekly Tech Article");

    // RSS includes weekly digest with title 'Weekly Digest — 2026-10-19' and link containing ?kind=weekly
    const rssRes = await digestFeedResponse(
      db(),
      "https://news.ioenv.com",
      "technology",
    );
    const rssXml = await rssRes.text();
    expect(rssXml).toContain("<title>Weekly Digest — 2026-10-19</title>");
    expect(rssXml).toContain(
      `<title>${SITE_NAME} — Technology Digests</title>`,
    );
    expect(rssXml).toContain(
      "<link>https://news.ioenv.com/digest/technology/2026-10-19?kind=weekly</link>",
    );
    expect(rssXml).toContain("Weekly overview narrative");
  });

  it("finance weekly digest carries disclaimer on public page and in RSS feed", async () => {
    const eventId = await seedEvent(finance.industryId, "Finance Event 1", 0);
    const artId = await seedArticle({
      ...finance,
      title: "Finance Article 1",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, artId, 1000);
    await seedReview(artId, "approved");

    const itemsJson = JSON.stringify([
      {
        eventId,
        title: "Finance Event 1",
        oneLiner: "Financial markets shift.",
        sourceName: "Finance Times",
        articleCount: 1,
      },
    ]);

    await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'weekly', '2026-10-19', 'UTC', 'ready', 'Finance weekly recap', ?2, 1000, 2000)`,
    )
      .bind(finance.industryId, itemsJson)
      .run();

    const result = await loadDigest(
      { section: "finance", date: "2026-10-19" },
      "weekly",
      {
        getDigest: (slug, date, kind) => getDigest(db(), slug, date, kind),
        getRecentDigests: (slug, kind) => getRecentDigests(db(), slug, 7, kind),
      },
    );

    expect(result.data.section.disclaimer).toBe(DISCLAIMER);

    const rssRes = await digestFeedResponse(
      db(),
      "https://news.ioenv.com",
      "finance",
    );
    const rssXml = await rssRes.text();
    expect(rssXml).toContain("<title>Weekly Digest — 2026-10-19</title>");
    expect(rssXml).toContain(DISCLAIMER);
  });

  it("falls back to daily digest when kind parameter is unrecognized or invalid", async () => {
    const eventId = await seedEvent(tech.industryId, "Tech Event Fallback", 0);
    const artId = await seedArticle({
      ...tech,
      title: "Tech Article Fallback",
      publishedAt: 1000,
    });
    await seedEventArticle(eventId, artId, 1000);
    await seedReview(artId, "approved");

    const itemsJson = JSON.stringify([
      {
        eventId,
        title: "Tech Event Fallback",
        oneLiner: "Fallback development.",
        sourceName: "Tech Wire",
        articleCount: 1,
      },
    ]);

    await env.DB.prepare(
      `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
       VALUES (?1, 'daily', '2026-10-21', 'UTC', 'ready', 'Daily recap', ?2, 1000, 2000)`,
    )
      .bind(tech.industryId, itemsJson)
      .run();

    // Passing undefined kind should default to daily
    const result = await loadDigest(
      { section: "technology", date: "2026-10-21" },
      undefined,
      {
        getDigest: (slug, date, kind) => getDigest(db(), slug, date, kind),
        getRecentDigests: (slug, kind) => getRecentDigests(db(), slug, 7, kind),
      },
    );

    expect(result.data.kind).toBe("daily");
    expect(result.data.periodStart).toBe("2026-10-21");
  });

  // #114: model-written copy (intro + one_liner) is shown only after the admin
  // approves it (digests.copy_approved_at). Article approval decides which items
  // appear; copy approval decides only whether the model text is shown.
  describe("#114 model copy approval", () => {
    const DATE = "2026-10-25";
    const fns = {
      getDigest: (slug: string, date: string) => getDigest(db(), slug, date),
      getRecentDigests: (slug: string) => getRecentDigests(db(), slug),
    };

    async function seedCopyDigest(o: {
      title?: string;
      summary?: string;
      eventRevision?: number;
      copyApprovedAt?: number;
    }): Promise<number> {
      const eventId = await seedEvent(tech.industryId, "Copy Event 114", 1);
      const artId = await seedArticle({
        ...tech,
        title: o.title ?? "Approved title 114",
        summary: o.summary ?? "Approved summary 114",
        publishedAt: 1000,
      });
      await seedEventArticle(eventId, artId, 1000);
      await seedReview(artId, "approved");
      const itemsJson = JSON.stringify([
        {
          eventId,
          eventRevision: o.eventRevision ?? 1,
          title: "Stored title 114",
          oneLiner: "MODEL LINER 114",
          sourceName: "Technology Wire",
          articleCount: 1,
        },
      ]);
      // copy_approved_at is named only when the test sets it, so the
      // unapproved cases run against the current schema.
      if (o.copyApprovedAt === undefined) {
        await env.DB.prepare(
          `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at)
           VALUES (?1, 'daily', ?2, 'UTC', 'ready', 'MODEL INTRO 114', ?3, 1000, 1000)`,
        )
          .bind(tech.industryId, DATE, itemsJson)
          .run();
      } else {
        await env.DB.prepare(
          `INSERT INTO digests (industry_id, kind, period_start, timezone, status, intro, items_json, created_at, published_at, copy_approved_at)
           VALUES (?1, 'daily', ?2, 'UTC', 'ready', 'MODEL INTRO 114', ?3, 1000, 1000, ?4)`,
        )
          .bind(tech.industryId, DATE, itemsJson, o.copyApprovedAt)
          .run();
      }
      return eventId;
    }

    async function techRss(): Promise<string> {
      const res = await digestFeedResponse(
        db(),
        "https://news.ioenv.com",
        "technology",
      );
      expect(res.status).toBe(200);
      return res.text();
    }

    it("unapproved copy: intro is hidden on page and RSS", async () => {
      await seedCopyDigest({});

      const view = await getDigest(db(), "technology", DATE);
      expect(view).not.toBeNull();
      expect(view!.intro).toBe("");

      const rss = await techRss();
      expect(rss).toContain(`Daily Digest — ${DATE}`);
      expect(rss).not.toContain("MODEL INTRO 114");
    });

    it("unapproved copy: item shows the approved article summary, not the one_liner", async () => {
      await seedCopyDigest({});

      const { data } = await loadDigest(
        { section: "technology", date: DATE },
        fns,
      );
      expect(data.items).toHaveLength(1);
      expect(data.items[0].oneLiner).toBe("Approved summary 114");
      expect(JSON.stringify(data)).not.toContain("MODEL LINER 114");

      const rss = await techRss();
      expect(rss).toContain("Approved summary 114");
      expect(rss).not.toContain("MODEL LINER 114");
    });

    it("unapproved copy: empty article title and summary never fall back to the one_liner", async () => {
      await seedCopyDigest({ title: "", summary: "" });

      const { data } = await loadDigest(
        { section: "technology", date: DATE },
        fns,
      );
      expect(data.items).toHaveLength(1);
      expect(data.items[0].oneLiner).not.toContain("MODEL LINER 114");
      expect(JSON.stringify(data)).not.toContain("MODEL LINER 114");

      const rss = await techRss();
      expect(rss).not.toContain("MODEL LINER 114");
    });

    it("empty approved title never falls back to the stored item title", async () => {
      // The stored title came from an article whose approval was later
      // revoked; only the current approved article may name the item.
      const eventId = await seedCopyDigest({ title: "" });
      const revokedId = await seedArticle({
        ...tech,
        title: "Stored title 114",
        publishedAt: 900,
      });
      await seedEventArticle(eventId, revokedId, 900);
      await seedReview(revokedId, "rejected");

      const { data } = await loadDigest(
        { section: "technology", date: DATE },
        fns,
      );
      expect(data.items).toHaveLength(1);
      expect(data.items[0].title).toBe("");
      expect(data.items[0].oneLiner).toBe("Approved summary 114");
      expect(JSON.stringify(data)).not.toContain("Stored title 114");

      const rss = await techRss();
      expect(rss).toContain("Approved summary 114");
      expect(rss).not.toContain("Stored title 114");
    });

    it("approved copy: intro and one_liner appear", async () => {
      await seedCopyDigest({ copyApprovedAt: 2000 });

      const view = await getDigest(db(), "technology", DATE);
      expect(view).not.toBeNull();
      expect(view!.intro).toBe("MODEL INTRO 114");
      expect(view!.items[0].oneLiner).toBe("MODEL LINER 114");

      const rss = await techRss();
      expect(rss).toContain("MODEL INTRO 114");
      expect(rss).toContain("MODEL LINER 114");
    });

    it("approved copy, event revision changed: item falls back to summary and intro hidden", async () => {
      // Stored item was built at revision 0; the event is now at revision 1.
      await seedCopyDigest({ copyApprovedAt: 2000, eventRevision: 0 });

      const view = await getDigest(db(), "technology", DATE);
      expect(view).not.toBeNull();
      expect(view!.intro).toBe("");
      expect(view!.items[0].oneLiner).toBe("Approved summary 114");

      const rss = await techRss();
      expect(rss).not.toContain("MODEL INTRO 114");
      expect(rss).not.toContain("MODEL LINER 114");
      expect(rss).toContain("Approved summary 114");
    });
  });
});
