import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueDueEvents, type DueKind } from "../../src/pipeline/due-events";
import type { GenerateMessage } from "../../src/pipeline/messages";

class FakeQueue {
  sent: GenerateMessage[] = [];
  async sendBatch(msgs: Iterable<{ body: GenerateMessage }>) {
    this.sent.push(...Array.from(msgs).map((m) => m.body));
  }
}

const KINDS: DueKind[] = ["artifacts", "evidence", "watch"];

describe("enqueueDueEvents eligibility (#92)", () => {
  let industryId = 0;
  let sourceId = 0;

  beforeEach(async () => {
    // Events left by earlier tests are not due on two counts (revision 0, no
    // articles), so each guard is tested alone by the tests below.
    await env.DB.prepare("UPDATE events SET revision = 0").run();
    await env.DB.prepare("DELETE FROM event_articles").run();
    const tag = crypto.randomUUID().slice(0, 8);
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES (?1, ?1, 'auto', 1000) RETURNING id",
    )
      .bind(`due92-${tag}`)
      .first<{ id: number }>();
    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, feed_url, site_domain, kind, created_at) VALUES (?1, ?2, ?3, 'rss', 1000) RETURNING id",
    )
      .bind(ind!.id, `https://due92-${tag}.test/feed`, `due92-${tag}.test`)
      .first<{ id: number }>();
    industryId = ind!.id;
    sourceId = src!.id;
  });

  /**
   * An event with one article. `review`: the article's review row, if any;
   * "stale" approves a body version the article no longer has.
   */
  async function seedEvent(
    revision: number,
    review: "approved" | "stale" | "none",
  ): Promise<number> {
    const event = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Due92 Event', ?2, 1000, 1000) RETURNING id",
    )
      .bind(industryId, revision)
      .first<{ id: number }>();
    const url = `https://example.com/due92/${crypto.randomUUID()}`;
    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, summary, body_sha, fetched_at, stage, stage_updated_at)
       VALUES (?1, ?2, ?3, ?3, 'Due92 Article', 'Summary', 'sha-current', 1000, 'grouped', 1000)
       RETURNING id`,
    )
      .bind(sourceId, industryId, url)
      .first<{ id: number }>();
    if (review !== "none") {
      await env.DB.prepare(
        "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, ?2, 'approved', 'admin', 1000)",
      )
        .bind(art!.id, review === "approved" ? "sha-current" : "sha-old")
        .run();
    }
    await env.DB.prepare(
      "INSERT INTO event_articles (event_id, article_id, created_at) VALUES (?1, ?2, 1000)",
    )
      .bind(event!.id, art!.id)
      .run();
    return event!.id;
  }

  async function enqueue(kind: DueKind) {
    const queue = new FakeQueue();
    const ids = await enqueueDueEvents(
      { DB: env.DB, Q_GENERATE: queue as unknown as Queue },
      kind,
      2000,
      20,
    );
    return { ids, sent: queue.sent };
  }

  it.each(KINDS)(
    "%s: an event at revision 0 is not due, even with an approved article",
    async (kind) => {
      const due = await seedEvent(1, "approved");
      await seedEvent(0, "approved");

      expect(await enqueue(kind)).toEqual({
        ids: [due],
        sent: [{ kind, eventId: due }],
      });
    },
  );

  it.each(KINDS)(
    "%s: an event whose only article is not approved is not due",
    async (kind) => {
      const due = await seedEvent(1, "approved");
      await seedEvent(1, "none");
      await seedEvent(1, "stale");

      expect(await enqueue(kind)).toEqual({
        ids: [due],
        sent: [{ kind, eventId: due }],
      });
    },
  );
});
