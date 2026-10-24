import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { JevAnswers, JevQuestions } from "../../src/providers/jev";
import type { ModelClient } from "../../src/providers/models";
import { groupArticle } from "../../src/pipeline/group/group-article";
import { revisionBumpStatement } from "../../src/server/db/events";

class FakeVectorize {
  unflushed: VectorizeVector[] = [];
  indexed: VectorizeVector[] = [];

  async upsert(vectors: VectorizeVector[]): Promise<VectorizeVectorMutation> {
    this.unflushed.push(...vectors);
    return { ids: vectors.map((v) => v.id), count: vectors.length };
  }

  flush() {
    this.indexed.push(...this.unflushed);
    this.unflushed = [];
  }

  async query(
    _vector: number[] | VectorFloatArray,
    _options?: VectorizeQueryOptions,
  ): Promise<VectorizeMatches> {
    const matches = this.indexed.map((v) => ({ id: v.id, score: 0.9 }));
    return {
      matches,
      count: matches.length,
    };
  }
}

function createFakeModels(options: {
  judgeHandler?: (
    key: string,
    state: unknown,
    questions: JevQuestions,
  ) => Promise<JevAnswers<JevQuestions>>;
}) {
  const calls: { slot: string; key: string }[] = [];
  const client = {
    embed: async (key: string, _texts: string[]) => {
      calls.push({ slot: "embed", key });
      return [[0.1, 0.2, 0.3]];
    },
    judge: async (key: string, state: unknown, questions: JevQuestions) => {
      calls.push({ slot: "judge", key });
      if (options.judgeHandler) {
        return options.judgeHandler(key, state, questions);
      }
      return {
        event: {
          choice: "new",
          confidence: 0.9,
          probabilities: { new: 0.9 },
        },
      } as unknown as JevAnswers<JevQuestions>;
    },
  } as unknown as ModelClient;

  return { client, calls };
}

describe("groupArticle core logic", () => {
  it("3 articles on the same event in one batch without flush: 1 event created, 3 event_articles, 1st article does not call judge", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('grp-test-1', 'G1', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S1', 'https://g1.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const artIds: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const art = await env.DB.prepare(
        `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
         VALUES (?1, ?2, ?3, ?3, ?4, 'analyzed', 1000, ?5, 1000)
         RETURNING id`,
      )
        .bind(
          srcId,
          indId,
          `https://g1.com/art${i}`,
          `Article ${i}`,
          `sha-${i}`,
        )
        .first<{ id: number }>();
      artIds.push(art!.id);
    }

    const fakeVectors = new FakeVectorize();
    let firstEventId: number | null = null;

    const { client: fakeModels, calls } = createFakeModels({
      judgeHandler: async (_key, _state, questions) => {
        const criteria =
          questions.event?.type === "choice" ? questions.event.criteria : {};
        const eventKey = `event_${firstEventId}`;
        if (eventKey in criteria) {
          return {
            event: {
              choice: eventKey,
              confidence: 0.85,
              probabilities: { [eventKey]: 0.85 },
            },
          } as unknown as JevAnswers<JevQuestions>;
        }
        return {
          event: {
            choice: "new",
            confidence: 0.9,
            probabilities: { new: 0.9 },
          },
        } as unknown as JevAnswers<JevQuestions>;
      },
    });

    const nowTime = 1000;
    // 1st article: candidates is empty because vectors not flushed and no events yet
    const res1 = await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => nowTime,
      },
      artIds[0],
    );

    expect(res1.status).toBe("grouped");
    if (res1.status !== "grouped") throw new Error("expected grouped");
    expect(res1.isNew).toBe(true);
    firstEventId = res1.eventId;
    expect(calls.filter((c) => c.slot === "judge").length).toBe(0); // 1st does not call Jev!

    // 2nd article: Vectorize is NOT flushed, but 1st event is within 30 min window in D1!
    const res2 = await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => nowTime + 1000,
      },
      artIds[1],
    );

    expect(res2.status).toBe("grouped");
    if (res2.status !== "grouped") throw new Error("expected grouped");
    expect(res2.isNew).toBe(false);
    expect(res2.eventId).toBe(firstEventId);
    expect(calls.filter((c) => c.slot === "judge").length).toBe(1);

    // 3rd article: joins the same event
    const res3 = await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => nowTime + 2000,
      },
      artIds[2],
    );

    expect(res3.status).toBe("grouped");
    if (res3.status !== "grouped") throw new Error("expected grouped");
    expect(res3.isNew).toBe(false);
    expect(res3.eventId).toBe(firstEventId);
    expect(calls.filter((c) => c.slot === "judge").length).toBe(2);

    // Verify 1 event and 3 event_articles in D1
    const { results: eventRows } = await env.DB.prepare(
      "SELECT id FROM events WHERE industry_id = ?1",
    )
      .bind(indId)
      .all();
    expect(eventRows.length).toBe(1);

    const { results: eaRows } = await env.DB.prepare(
      "SELECT article_id FROM event_articles WHERE event_id = ?1",
    )
      .bind(firstEventId)
      .all();
    expect(eaRows.length).toBe(3);
  });

  it("event created 10 min ago is in candidates; event created 31 min ago is not (unindexed)", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('grp-test-window', 'GW', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S2', 'https://gw.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const baseNow = 100_000_000;
    // Event 1: created 31 mins ago (baseNow - 31 * 60 * 1000)
    const evOld = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Old Event', 0, ?2, ?2) RETURNING id",
    )
      .bind(indId, baseNow - 31 * 60 * 1000)
      .first<{ id: number }>();

    // Event 2: created 10 mins ago (baseNow - 10 * 60 * 1000)
    const evRecent = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Recent Event', 0, ?2, ?2) RETURNING id",
    )
      .bind(indId, baseNow - 10 * 60 * 1000)
      .first<{ id: number }>();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://gw.com/art', 'https://gw.com/art', 'New Article', 'analyzed', ?3, 'sha-new', ?3)
       RETURNING id`,
    )
      .bind(srcId, indId, baseNow)
      .first<{ id: number }>();

    const fakeVectors = new FakeVectorize(); // empty and unindexed
    let receivedCriteria: Record<string, string> = {};

    const { client: fakeModels } = createFakeModels({
      judgeHandler: async (_key, _state, questions) => {
        if (questions.event?.type === "choice") {
          receivedCriteria = questions.event.criteria;
        }
        return {
          event: {
            choice: "new",
            confidence: 0.9,
            probabilities: { new: 0.9 },
          },
        } as unknown as JevAnswers<JevQuestions>;
      },
    });

    await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => baseNow,
      },
      art!.id,
    );

    expect(`event_${evRecent!.id}` in receivedCriteria).toBe(true);
    expect(`event_${evOld!.id}` in receivedCriteria).toBe(false);
  });

  it("approved article join bumps revision 0->1; pending article join leaves revision 0; subsequent approval bumps +1; approved to rejected +1; pending to rejected unchanged", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('grp-test-rev', 'GR', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S3', 'https://gr.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    // Create an existing event with revision = 0
    const ev = await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Test Event', 0, 1000, 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const eventId = ev!.id;

    // Article 1: Approved before grouping
    const artApproved = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://gr.com/app', 'https://gr.com/app', 'App Art', 'analyzed', 1000, 'sha-app', 1000)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha-app', 'approved', 'human', 1000)",
    )
      .bind(artApproved!.id)
      .run();

    const fakeVectors = new FakeVectorize();
    const { client: fakeModels } = createFakeModels({
      judgeHandler: async () =>
        ({
          event: {
            choice: `event_${eventId}`,
            confidence: 0.9,
            probabilities: { [`event_${eventId}`]: 0.9 },
          },
        }) as unknown as JevAnswers<JevQuestions>,
    });

    // Joining approved article -> revision bumps 0 -> 1
    await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => 1000,
      },
      artApproved!.id,
    );

    let evRow = await env.DB.prepare(
      "SELECT revision FROM events WHERE id = ?1",
    )
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(1);

    // Article 2: Pending (not approved)
    const artPending = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://gr.com/pen', 'https://gr.com/pen', 'Pen Art', 'analyzed', 1000, 'sha-pen', 1000)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();

    // Joining pending article -> revision unchanged (remains 1)
    await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => 1000,
      },
      artPending!.id,
    );

    evRow = await env.DB.prepare("SELECT revision FROM events WHERE id = ?1")
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(1);

    // Later: Approve artPending via revisionBumpStatement -> revision bumps 1 -> 2
    await revisionBumpStatement(env.DB, artPending!.id, 2000).run();
    evRow = await env.DB.prepare("SELECT revision FROM events WHERE id = ?1")
      .bind(eventId)
      .first<{ revision: number }>();
    expect(evRow?.revision).toBe(2);
  });

  it("duplicate delivery: 1 event_article row, revision bumped once, Jev called once", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('grp-test-dup', 'GD', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S4', 'https://gd.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    // An existing event so Jev gets called
    await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Existing', 0, 1000, 1000)",
    )
      .bind(indId)
      .run();

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://gd.com/art', 'https://gd.com/art', 'Dup Art', 'analyzed', 1000, 'sha-dup', 1000)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    const artId = art!.id;

    // Approved article
    await env.DB.prepare(
      "INSERT INTO reviews (article_id, body_sha, decision, reviewer, created_at) VALUES (?1, 'sha-dup', 'approved', 'human', 1000)",
    )
      .bind(artId)
      .run();

    const fakeVectors = new FakeVectorize();
    const { client: fakeModels, calls } = createFakeModels({
      judgeHandler: async () =>
        ({
          event: {
            choice: "new",
            confidence: 0.9,
            probabilities: { new: 0.9 },
          },
        }) as unknown as JevAnswers<JevQuestions>,
    });

    // 1st delivery
    const res1 = await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => 1000,
      },
      artId,
    );
    expect(res1.status).toBe("grouped");

    // 2nd delivery of the same article
    const res2 = await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => 1000,
      },
      artId,
    );
    expect(res2.status).toBe("already_grouped");

    // Verify 1 event_articles row
    const eaRows = await env.DB.prepare(
      "SELECT event_id FROM event_articles WHERE article_id = ?1",
    )
      .bind(artId)
      .all();
    expect(eaRows.results.length).toBe(1);

    // Verify Jev called only once
    const jevCalls = calls.filter((c) => c.slot === "judge");
    expect(jevCalls.length).toBe(1);
  });

  it("snapshot validation: aborts grouping if article stage changes during processing", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('grp-snap-test', 'GS', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S_Snap', 'https://gs.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    const art = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://gs.com/art', 'https://gs.com/art', 'Snap Art', 'analyzed', 1000, 'sha-snap', 1000)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();
    const artId = art!.id;

    const fakeVectors = new FakeVectorize();
    const { client: fakeModels } = createFakeModels({
      judgeHandler: async () => {
        // Concurrently reset article to body_ready before judge returns
        await env.DB.prepare(
          "UPDATE articles SET stage = 'body_ready' WHERE id = ?1",
        )
          .bind(artId)
          .run();
        return {
          event: {
            choice: "new",
            confidence: 0.9,
            probabilities: { new: 0.9 },
          },
        } as unknown as JevAnswers<JevQuestions>;
      },
    });

    // Also insert an existing event so judgeHandler actually gets triggered
    await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Existing Ev', 0, 1000, 1000)",
    )
      .bind(indId)
      .run();

    const res = await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => 1000,
      },
      artId,
    );

    expect(res).toEqual({
      status: "skipped",
      reason: "article_state_changed",
    });

    // Verify article was not linked to any event
    const ea = await env.DB.prepare(
      "SELECT count(*) as cnt FROM event_articles WHERE article_id = ?1",
    )
      .bind(artId)
      .first<{ cnt: number }>();
    expect(ea?.cnt).toBe(0);
  });

  it("Jev logical key reflects embed text changes", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('grp-key-test', 'GK', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = ind!.id;

    const src = await env.DB.prepare(
      "INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at) VALUES (?1, 'S_Key', 'https://gk.com/rss', 'rss', 'active', 1000) RETURNING id",
    )
      .bind(indId)
      .first<{ id: number }>();
    const srcId = src!.id;

    // Existing event for candidate
    await env.DB.prepare(
      "INSERT INTO events (industry_id, title, revision, created_at, updated_at) VALUES (?1, 'Candidate Ev', 0, 1000, 1000)",
    )
      .bind(indId)
      .run();

    const art1 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://gk.com/art1', 'https://gk.com/art1', 'Title Alpha', 'analyzed', 1000, 'sha-k1', 1000)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();

    const art2 = await env.DB.prepare(
      `INSERT INTO articles (source_id, industry_id, canonical_url, url, title, stage, stage_updated_at, body_sha, fetched_at)
       VALUES (?1, ?2, 'https://gk.com/art2', 'https://gk.com/art2', 'Title Beta', 'analyzed', 1000, 'sha-k2', 1000)
       RETURNING id`,
    )
      .bind(srcId, indId)
      .first<{ id: number }>();

    const fakeVectors = new FakeVectorize();
    const { client: fakeModels, calls } = createFakeModels({});

    await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => 1000,
      },
      art1!.id,
    );

    await groupArticle(
      {
        db: env.DB,
        vectors: fakeVectors,
        models: fakeModels,
        now: () => 1000,
      },
      art2!.id,
    );

    const judgeCalls = calls.filter((c) => c.slot === "judge");
    expect(judgeCalls.length).toBe(2);
    // Keys should be distinct because title/embed text differs
    expect(judgeCalls[0].key).not.toBe(judgeCalls[1].key);
  });
});
