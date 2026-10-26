// #102: watch/evaluate.ts judges only approved articles of the event.
// The query joins reviews on the current body_sha, so an article with no review
// or a stale review is gone before the approved condition runs. Only a
// rejected review for the current body is left for that condition to remove.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { evaluateEventWatches } from "../../src/pipeline/watch/evaluate";
import type { ModelClient } from "../../src/providers/models";
import {
  seedArticleInEvent,
  seedEvent,
  seedSection,
} from "./approved-behaviour-helpers";

describe("evaluateEventWatches approved condition (#102)", () => {
  it("judges the approved article only, not a rejected, unreviewed or stale one", async () => {
    const section = await seedSection();
    const eventId = await seedEvent(section.industryId);
    // The rejected article is the newest, so it would set the title and
    // be in the new reporting.
    await seedArticleInEvent(eventId, section, {
      kind: "approved",
      title: "Zebra approved headline",
      summary: "Zebra approved summary quasar",
      linkedAt: 1000,
      reviewedAt: 1000,
    });
    await seedArticleInEvent(eventId, section, {
      kind: "none",
      title: "Quokka unreviewed headline",
      linkedAt: 1000,
    });
    await seedArticleInEvent(eventId, section, {
      kind: "stale",
      title: "Narwhal stale headline",
      linkedAt: 1000,
      reviewedAt: 1000,
    });
    await seedArticleInEvent(eventId, section, {
      kind: "rejected",
      title: "Marmot rejected headline",
      linkedAt: 1001,
      reviewedAt: 1001,
    });
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, created_at, updated_at)
       VALUES (?1, 'Quasar news?', 'Any', '["quasar"]', ?2, 'active', 500, 500)`,
    )
      .bind(`appr102-w-${section.tag}`, section.industryId)
      .run();

    const states: { title: string; summary: string; body: string }[] = [];
    const judge = vi.fn(
      async (_key: string, state: (typeof states)[number]) => {
        states.push(state);
        return { progress: { noul: 0 } };
      },
    );
    const models = {
      judge,
      generateText: vi.fn(),
    } as unknown as ModelClient;

    const res = await evaluateEventWatches(env, eventId, 5000, { models });

    expect(res.evaluatedCount).toBe(1);
    expect(states).toHaveLength(1);
    const seen = JSON.stringify(states[0]);
    expect(seen).toContain("Zebra approved headline");
    for (const other of ["Quokka", "Narwhal", "Marmot"]) {
      expect(seen).not.toContain(other);
    }
  });
});
