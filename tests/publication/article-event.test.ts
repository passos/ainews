// #87 A3a: the sidebar of /a/$id lists the sections of the article's story.
// It reads the same data and applies the same rules as the /e/$id nav.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getArticlePageWithEvent } from "../../src/server/publication/event-sections";
import {
  db,
  resetPublication,
  seedArticle,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "./helpers";

let tech: { industryId: number; sourceId: number };
let fin: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech, finance: fin } = await seedSections());
});

const BRIEF =
  '{"whatHappened":"The WH sentence.","whatIsNew":"n","whatEvidenceExists":"e","whatToWatchNext":"w"}';
const EXPLAIN =
  '{"audience":"student","overview":"o","keyPoints":["k"],"implications":["i"],"glossary":[]}';

async function artifact(
  eventId: number,
  type: string,
  audience: string,
  content: string,
  o: { revision?: number; status?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO event_artifacts (event_id, type, audience, input_revision, prompt_version, model, content, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'pv1', 'gemini', ?5, ?6, 1000)`,
  )
    .bind(
      eventId,
      type,
      audience,
      o.revision ?? 1,
      content,
      o.status ?? "published",
    )
    .run();
}

async function claim(eventId: number, articleId: number): Promise<void> {
  const c = await env.DB.prepare(
    `INSERT INTO claims (event_id, input_revision, prompt_version, model, claim_text, claim_type, consensus_status, status, primary_source_preferred, created_at)
     VALUES (?1, 1, 'pv1', 'gemini', 'A claim', 'fact', 'verified', 'published', 0, 0) RETURNING id`,
  )
    .bind(eventId)
    .first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO claim_evidence (claim_id, article_id, body_sha, stance, quote, quote_clean, start_offset, end_offset, verified, is_primary_source, created_at)
     VALUES (?1, ?2, 'sha-current', 'support', 'Quoted words', 'Quoted words', 0, 12, 1, 0, 0)`,
  )
    .bind(c!.id, articleId)
    .run();
}

async function inEvent(
  s: { industryId: number; sourceId: number } = tech,
  approved = true,
) {
  const eventId = await seedEvent(s.industryId, "Event", 1);
  const articleId = await seedArticle({ ...s, title: "Reader" });
  await seedEventArticle(eventId, articleId);
  if (approved) await seedReview(articleId, "approved");
  return { eventId, articleId };
}

const page = (id: number, askEnabled = true) =>
  getArticlePageWithEvent(db(), env.BODIES, id, { askEnabled });

describe("getArticlePageWithEvent", () => {
  it("article in a story: sentence and the sections the story page shows", async () => {
    const { eventId, articleId } = await inEvent();
    await artifact(eventId, "story_brief", "", BRIEF);
    await artifact(eventId, "audience_explain", "student", EXPLAIN);
    await claim(eventId, articleId);
    const p = await page(articleId);
    expect(p!.event).toEqual({
      whatHappened: "The WH sentence.",
      sections: { brief: true, evidenceClaims: 1, explain: true, ask: true },
    });
  });

  it("article without a story: event is null", async () => {
    const id = await seedArticle({ ...tech, title: "Lone" });
    await seedReview(id, "approved");
    expect((await page(id))!.event).toBeNull();
  });

  it("story without a brief: no sentence, brief false", async () => {
    const { articleId } = await inEvent();
    const p = await page(articleId);
    expect(p!.event).toEqual({
      whatHappened: null,
      sections: { brief: false, evidenceClaims: 0, explain: false, ask: true },
    });
  });

  it("a brief the story page does not show gives no sentence", async () => {
    // Stale revision, then a pending one: neither is public.
    const stale = await inEvent();
    await artifact(stale.eventId, "story_brief", "", BRIEF, { revision: 0 });
    expect((await page(stale.articleId))!.event!.whatHappened).toBeNull();
    const pending = await inEvent();
    await artifact(pending.eventId, "story_brief", "", BRIEF, {
      status: "pending_review",
    });
    const p = await page(pending.articleId);
    expect(p!.event!.whatHappened).toBeNull();
    expect(p!.event!.sections.brief).toBe(false);
  });

  it("an unapproved article has no page and so no story data", async () => {
    const { eventId, articleId } = await inEvent(tech, false);
    await artifact(eventId, "story_brief", "", BRIEF);
    expect(await page(articleId)).toBeNull();
  });

  it("a story whose other reports are unapproved still lists its brief", async () => {
    const { eventId, articleId } = await inEvent();
    const other = await seedArticle({ ...tech, title: "Pending" });
    await seedEventArticle(eventId, other);
    await artifact(eventId, "story_brief", "", BRIEF);
    expect((await page(articleId))!.event!.sections.brief).toBe(true);
  });

  it("Ask: off with the switch and on a Finance story", async () => {
    const t = await inEvent();
    expect((await page(t.articleId, false))!.event!.sections.ask).toBe(false);
    const f = await inEvent(fin);
    expect((await page(f.articleId, true))!.event!.sections.ask).toBe(false);
  });
});
