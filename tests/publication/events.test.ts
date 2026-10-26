import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getHome, getSection } from "../../src/server/publication/articles";
import { getEvent, getEventSources } from "../../src/server/publication/events";
import { computeRevisionDiff } from "../../src/pipeline/evidence/diff";
import { attributeSource } from "../../src/lib/source-attribution";
import {
  db,
  resetPublication,
  seedArticle,
  seedCorrection,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "./helpers";

let tech: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
});

describe("getEvent and getEventSources", () => {
  it("event with 1 approved + 1 pending article: returns only approved article, title comes from it", async () => {
    const eventId = await seedEvent(tech.industryId, "Internal Event Title", 0);

    const art1 = await seedArticle({
      ...tech,
      title: "First Approved Report",
      publishedAt: 1000,
    });
    const art2 = await seedArticle({
      ...tech,
      title: "Pending Report",
      publishedAt: 2000,
    });

    await seedEventArticle(eventId, art1, 1000);
    await seedEventArticle(eventId, art2, 2000);

    // Only art1 is approved
    await seedReview(art1, "approved");

    const event = await getEvent(db(), eventId);
    expect(event).not.toBeNull();
    // Public title comes from earliest approved article
    expect(event?.title).toBe("First Approved Report");
    expect(event?.articles.map((a) => a.id)).toEqual([art1]);
    expect(event?.section.slug).toBe("technology");
  });

  it("event with only pending/rejected articles returns null", async () => {
    const eventId = await seedEvent(tech.industryId, "Internal Event", 0);
    const art1 = await seedArticle({ ...tech, title: "Rejected Art" });
    const art2 = await seedArticle({ ...tech, title: "Pending Art" });

    await seedEventArticle(eventId, art1, 1000);
    await seedEventArticle(eventId, art2, 2000);

    await seedReview(art1, "rejected");
    // art2 has no review

    const event = await getEvent(db(), eventId);
    expect(event).toBeNull();
  });

  it("non-existent event returns null", async () => {
    const event = await getEvent(db(), 999999);
    expect(event).toBeNull();
  });

  it("getEvent returns event public corrections", async () => {
    const eventId = await seedEvent(tech.industryId, "Ev Title", 0);
    const art = await seedArticle({ ...tech, title: "Art" });
    await seedEventArticle(eventId, art, 1000);
    await seedReview(art, "approved");

    await seedCorrection("events", eventId, "Correction note 1", 100);
    await seedCorrection("events", eventId, "Correction note 2", 200);

    const event = await getEvent(db(), eventId);
    expect(event?.corrections).toEqual([
      "Correction note 2",
      "Correction note 1",
    ]);
  });

  it("getEventSources counts sources for approved articles only", async () => {
    const eventId = await seedEvent(tech.industryId, "Multi Source Event", 0);

    const art1 = await seedArticle({ ...tech, title: "Tech Wire 1" });
    const art2 = await seedArticle({ ...tech, title: "Tech Wire 2" });
    const art3 = await seedArticle({
      ...tech,
      title: "Tech Wire 3 (rejected)",
    });

    await seedEventArticle(eventId, art1, 1000);
    await seedEventArticle(eventId, art2, 2000);
    await seedEventArticle(eventId, art3, 3000);

    await seedReview(art1, "approved");
    await seedReview(art2, "approved");
    await seedReview(art3, "rejected");

    const sources = await getEventSources(db(), eventId);
    expect(sources).toEqual([{ name: "Technology Wire", count: 2 }]);
  });

  it("a system placeholder source shows the document host, not its name", async () => {
    const placeholder = await db().get<{ id: number }>(
      sql`INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at)
          VALUES (${tech.industryId}, 'Primary documents (system)', 'system:primary-documents', 'html', 'paused', 0)
          RETURNING id`,
    );
    const eventId = await seedEvent(tech.industryId, "Primary Event", 0);
    const nasa = await seedArticle({
      industryId: tech.industryId,
      sourceId: placeholder.id,
      title: "NASA report",
      url: "https://www.nasa.gov/report",
    });
    const wire = await seedArticle({ ...tech, title: "Wire report" });
    for (const [i, id] of [nasa, wire].entries()) {
      await seedEventArticle(eventId, id, 1000 + i);
      await seedReview(id, "approved");
    }

    expect(await getEventSources(db(), eventId)).toEqual([
      { name: "Technology Wire", count: 1 },
      { name: "nasa.gov", count: 1 },
    ]);
    const section = await getSection(db(), { slug: "technology", page: 1 });
    const card = section!.articles.find((a) => a.id === nasa);
    expect(card?.sourceName).toBe("nasa.gov");
    expect(section!.articles.find((a) => a.id === wire)?.sourceName).toBe(
      "Technology Wire",
    );
  });

  it("getSection and getHome return eventId and eventReportCount; card shows event link when >= 2 reports", async () => {
    const eventId = await seedEvent(tech.industryId, "Big Story", 0);

    const art1 = await seedArticle({ ...tech, title: "Story Part 1" });
    const art2 = await seedArticle({ ...tech, title: "Story Part 2" });
    const artSingle = await seedArticle({ ...tech, title: "Solo Story" });

    await seedEventArticle(eventId, art1, 1000);
    await seedEventArticle(eventId, art2, 2000);

    await seedReview(art1, "approved");
    await seedReview(art2, "approved");
    await seedReview(artSingle, "approved");

    const sectionData = await getSection(db(), {
      slug: "technology",
      page: 1,
    });
    const a1View = sectionData?.articles.find((a) => a.id === art1);
    const aSingleView = sectionData?.articles.find((a) => a.id === artSingle);

    expect(a1View?.eventId).toBe(eventId);
    expect(a1View?.eventReportCount).toBe(2);

    expect(aSingleView?.eventId).toBeNull();
    expect(aSingleView?.eventReportCount).toBe(0);

    const homeData = await getHome(db());
    const homeA1 = homeData.sections
      .find((s) => s.slug === "technology")
      ?.articles.find((a) => a.id === art1);
    expect(homeA1?.eventId).toBe(eventId);
    expect(homeA1?.eventReportCount).toBe(2);
  });

  it("pipeline and publication name a placeholder-source document identically", async () => {
    const placeholder = await db().get<{ id: number }>(
      sql`INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at)
          VALUES (${tech.industryId}, 'Primary documents (system)', 'system:primary-documents', 'html', 'paused', 0)
          RETURNING id`,
    );
    const urls = [
      "https://user:pw@WWW.NASA.gov:8443/a",
      "https://data.sec.gov:443/b",
      "ftp://ftp.example.org/c",
    ];
    const eventId = await seedEvent(tech.industryId, "Consistency Event", 1);
    const ids: number[] = [];
    for (const url of urls) {
      const id = await seedArticle({
        industryId: tech.industryId,
        sourceId: placeholder.id,
        title: `Doc ${url}`,
        url,
      });
      await seedEventArticle(eventId, id, 1000, 1);
      await seedReview(id, "approved");
      ids.push(id);
    }
    const expected = urls.map(
      (canonicalUrl) =>
        attributeSource({
          name: "Primary documents (system)",
          siteDomain: null,
          feedUrl: "system:primary-documents",
          canonicalUrl,
        }).name,
    );

    const pipeline = (await computeRevisionDiff(
      (await import("cloudflare:workers")).env.DB,
      eventId,
      1,
    ))!.newSources;
    const publicNames = (await getEventSources(db(), eventId))
      .map((s) => s.name)
      .sort();
    const page = await getSection(db(), { slug: "technology", page: 1 });
    const cards = ids.map(
      (id) => page!.articles.find((a) => a.id === id)!.sourceName,
    );

    expect(pipeline).toEqual(expected);
    expect(cards).toEqual(expected);
    expect(publicNames).toEqual([...expected].sort());
  });

  it("an upper-case SYSTEM: source is attributed to the document host on both paths", async () => {
    const placeholder = await db().get<{ id: number }>(
      sql`INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at)
          VALUES (${tech.industryId}, 'Upper system row', 'SYSTEM:x', 'html', 'paused', 0)
          RETURNING id`,
    );
    const urls = ["https://www.nasa.gov/a", "https://data.sec.gov/b"];
    const eventId = await seedEvent(tech.industryId, "Upper Case Event", 1);
    const ids: number[] = [];
    for (const url of urls) {
      const id = await seedArticle({
        industryId: tech.industryId,
        sourceId: placeholder.id,
        title: `Doc ${url}`,
        url,
      });
      await seedEventArticle(eventId, id, 1000, 1);
      await seedReview(id, "approved");
      ids.push(id);
    }
    const expected = ["nasa.gov", "data.sec.gov"];

    const pipeline = (await computeRevisionDiff(
      (await import("cloudflare:workers")).env.DB,
      eventId,
      1,
    ))!.newSources;
    const publicNames = (await getEventSources(db(), eventId))
      .map((s) => s.name)
      .sort();
    const page = await getSection(db(), { slug: "technology", page: 1 });
    const cards = ids.map(
      (id) => page!.articles.find((a) => a.id === id)!.sourceName,
    );

    expect(pipeline).toEqual(expected);
    expect(cards).toEqual(expected);
    expect(publicNames).toEqual([...expected].sort());
  });
});
