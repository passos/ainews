// #102: digest/build.ts counts only approved articles, in the item fields and
// in the candidate event filters. No transport: the one-liner is the summary
// of the newest approved article, so a model cannot hide a wrong summary.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildDigest } from "../../src/pipeline/digest/build";
import type { PipelineEnv } from "../../src/pipeline/messages";
import {
  seedArticleInEvent,
  seedEvent,
  seedSection,
  type SeededSection,
} from "./approved-behaviour-helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAILY_START = Date.parse("2026-10-21T00:00:00Z");
const WEEKLY_START = Date.parse("2026-10-19T00:00:00Z");

interface Item {
  eventId: number;
  title: string;
  oneLiner: string;
  sourceName: string;
  articleCount: number;
}

async function build(
  section: SeededSection,
  digestKind: "daily" | "weekly",
  periodStart: string,
): Promise<Item[]> {
  await buildDigest(
    { ...env } as PipelineEnv,
    { kind: "digest", industryId: section.industryId, digestKind, periodStart },
    Date.parse("2026-10-27T01:00:00Z"),
  );
  const row = await env.DB.prepare(
    "SELECT items_json FROM digests WHERE industry_id = ?1 AND kind = ?2 AND period_start = ?3",
  )
    .bind(section.industryId, digestKind, periodStart)
    .first<{ items_json: string }>();
  return JSON.parse(row!.items_json) as Item[];
}

/**
 * Event X: approved article A (middle date, score 10), an unreviewed article
 * (oldest) and a stale one (newest, score 90), each on its own source.
 * Event Y: one approved article, score 50. Right: Y before X.
 */
async function seedContent(
  section: SeededSection,
  at: { eventCreatedAt: number; reviewedAt: number },
) {
  const x = await seedEvent(section.industryId, {
    createdAt: at.eventCreatedAt,
    updatedAt: at.eventCreatedAt,
  });
  await seedArticleInEvent(x, section, {
    kind: "none",
    title: "Quokka unreviewed",
    summary: "Quokka summary",
    sourceName: "Quokka Wire",
    publishedAt: 2000,
    score: 95,
  });
  await seedArticleInEvent(x, section, {
    kind: "approved",
    title: "Zebra approved",
    summary: "Zebra summary",
    sourceName: "Zebra Wire",
    publishedAt: 3000,
    score: 10,
    reviewedAt: at.reviewedAt,
    linkedAt: at.reviewedAt,
  });
  await seedArticleInEvent(x, section, {
    kind: "stale",
    title: "Narwhal stale",
    summary: "Narwhal summary",
    sourceName: "Narwhal Wire",
    publishedAt: 4000,
    score: 90,
    reviewedAt: at.reviewedAt,
    linkedAt: at.reviewedAt,
  });
  const y = await seedEvent(section.industryId, {
    createdAt: at.eventCreatedAt,
    updatedAt: at.eventCreatedAt - 1,
  });
  await seedArticleInEvent(y, section, {
    kind: "approved",
    title: "Lemur approved",
    summary: "Lemur summary",
    sourceName: "Lemur Wire",
    publishedAt: 5000,
    score: 50,
    reviewedAt: at.reviewedAt,
    linkedAt: at.reviewedAt,
  });
  return { x, y };
}

function expectContent(items: Item[], x: number, y: number) {
  expect(items.map((i) => i.eventId)).toEqual([y, x]);
  expect(items[1]).toMatchObject({
    title: "Zebra approved",
    oneLiner: "Zebra summary",
    sourceName: "Zebra Wire",
    articleCount: 1,
  });
}

describe("buildDigest approved condition (#102)", () => {
  it("daily: title, summary, source, score and count come from approved articles", async () => {
    const section = await seedSection();
    const { x, y } = await seedContent(section, {
      eventCreatedAt: DAILY_START - DAY,
      reviewedAt: DAILY_START + HOUR,
    });
    expectContent(await build(section, "daily", "2026-10-21"), x, y);
  });

  it("daily: an event whose approved article was reviewed outside the window is left out", async () => {
    const section = await seedSection();
    const control = await seedEvent(section.industryId);
    await seedArticleInEvent(control, section, {
      kind: "approved",
      title: "Control",
      reviewedAt: DAILY_START + HOUR,
    });
    // Approved before the window; a rejection inside the window must not
    // pull the event in.
    const z = await seedEvent(section.industryId);
    await seedArticleInEvent(z, section, {
      kind: "approved",
      title: "Old approval",
      reviewedAt: DAILY_START - HOUR,
    });
    await seedArticleInEvent(z, section, {
      kind: "rejected",
      title: "Rejected in window",
      reviewedAt: DAILY_START + HOUR,
    });
    const items = await build(section, "daily", "2026-10-21");
    expect(items.map((i) => i.eventId)).toEqual([control]);
  });

  it("weekly: title, summary, source, score and count come from approved articles", async () => {
    const section = await seedSection();
    const { x, y } = await seedContent(section, {
      eventCreatedAt: WEEKLY_START + HOUR,
      reviewedAt: WEEKLY_START + 2 * HOUR,
    });
    expectContent(await build(section, "weekly", "2026-10-19"), x, y);
  });

  it("weekly: only an approved article's review or link time can pull an event into the window", async () => {
    const section = await seedSection();
    const control = await seedEvent(section.industryId, {
      createdAt: WEEKLY_START + HOUR,
      updatedAt: WEEKLY_START + HOUR,
    });
    await seedArticleInEvent(control, section, {
      kind: "approved",
      title: "Control",
      reviewedAt: WEEKLY_START + HOUR,
      linkedAt: WEEKLY_START + HOUR,
    });
    // Created and updated before the window; the approved article was
    // reviewed and linked before it too.
    const z = await seedEvent(section.industryId, {
      createdAt: 1000,
      updatedAt: 1000,
    });
    await seedArticleInEvent(z, section, {
      kind: "approved",
      title: "Old approval",
      reviewedAt: 1000,
      linkedAt: 1000,
    });
    // Reviewed (rejected) inside the window.
    await seedArticleInEvent(z, section, {
      kind: "rejected",
      title: "Rejected in window",
      reviewedAt: WEEKLY_START + HOUR,
      linkedAt: 1000,
    });
    // Linked inside the window, never reviewed.
    await seedArticleInEvent(z, section, {
      kind: "none",
      title: "Unreviewed, linked in window",
      linkedAt: WEEKLY_START + HOUR,
    });
    const items = await build(section, "weekly", "2026-10-19");
    expect(items.map((i) => i.eventId)).toEqual([control]);
  });
});
