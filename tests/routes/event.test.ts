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
});
