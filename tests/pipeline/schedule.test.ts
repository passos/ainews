import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { countSightings, pauseStale } from "../../src/pipeline/collect/health";
import { scheduleDueSources } from "../../src/pipeline/collect/schedule";
import {
  DAY,
  fakeQueue,
  MIN,
  NOW,
  ON,
  pipelineEnv,
  resetPipeline,
  seedArticle,
  seedIndustry,
  seedSource,
  sourceRow,
} from "./helpers";

let industry: number;
beforeEach(async () => {
  await resetPipeline();
  industry = await seedIndustry("ai");
});

const src = (
  n: number,
  extra: Partial<Parameters<typeof seedSource>[0]> = {},
) =>
  seedSource({
    industryId: industry,
    feedUrl: `https://s${n}.example/feed`,
    ...extra,
  });

describe("scheduleDueSources", () => {
  it("sends one collect per due active source, also when two crons overlap", async () => {
    const due = [
      await src(1),
      await src(2, { nextFetchAt: NOW }),
      await src(3, { nextFetchAt: NOW - MIN }),
    ];
    const later = await src(4, { nextFetchAt: NOW + 1 });
    await src(5, { status: "paused" });
    await src(6, { status: "candidate" });
    const q = fakeQueue();
    const e = pipelineEnv(q, ON);
    const [a, b] = await Promise.all([
      scheduleDueSources(e, NOW),
      scheduleDueSources(e, NOW),
    ]);
    expect([...a, ...b].sort()).toEqual(due.sort());
    expect(q.sent).toEqual(
      due.map((sourceId) => ({ kind: "collect", sourceId })),
    );
    // Claimed: next due one interval (60 min default) later.
    expect((await sourceRow(due[0]))?.next_fetch_at).toBe(NOW + 60 * MIN);
    expect(await scheduleDueSources(e, NOW + 59 * MIN)).toEqual([later]);
  });

  it("claims and sends nothing while COLLECT_ENABLED is off", async () => {
    const id = await src(1);
    const q = fakeQueue();
    expect(await scheduleDueSources(pipelineEnv(q), NOW)).toEqual([]);
    expect(q.sent).toHaveLength(0);
    expect((await sourceRow(id))?.next_fetch_at).toBe(0);
  });

  it("sends more than 100 messages in batches of at most 100", async () => {
    await env.DB.batch(
      Array.from({ length: 150 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO sources (industry_id, feed_url, kind, status, created_at) VALUES (?1, ?2, 'rss', 'active', 0)",
        ).bind(industry, `https://bulk.example/${i}`),
      ),
    );
    const q = fakeQueue();
    expect(await scheduleDueSources(pipelineEnv(q, ON), NOW)).toHaveLength(150);
    expect(q.batches).toBe(2);
  });
});

describe("pauseStale", () => {
  const old = NOW - 31 * DAY;
  const recentOk = NOW - DAY;

  it("pauses only a source that is old, fetched recently, and saw nothing new for 30 days", async () => {
    const stale = await src(1, { createdAt: old, lastOkAt: recentOk });
    const young = await src(2, {
      createdAt: NOW - 29 * DAY,
      lastOkAt: recentOk,
    });
    const neverFetched = await src(3, { createdAt: old, lastOkAt: null });
    const notFetchedLately = await src(4, {
      createdAt: old,
      lastOkAt: NOW - 31 * DAY,
    });
    const fresh = await src(5, { createdAt: old, lastOkAt: recentOk });
    const oldSighting = await src(6, { createdAt: old, lastOkAt: recentOk });
    const paused = await src(7, {
      createdAt: old,
      lastOkAt: recentOk,
      status: "paused",
    });
    const a1 = await seedArticle({
      sourceId: fresh,
      industryId: industry,
      url: "https://a/1",
      stageUpdatedAt: 0,
    });
    const a2 = await seedArticle({
      sourceId: oldSighting,
      industryId: industry,
      url: "https://a/2",
      stageUpdatedAt: 0,
    });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO article_sightings VALUES (?1, ?2, ?3)").bind(
        a1,
        fresh,
        NOW - 29 * DAY,
      ),
      env.DB.prepare("INSERT INTO article_sightings VALUES (?1, ?2, ?3)").bind(
        a2,
        oldSighting,
        NOW - 31 * DAY,
      ),
    ]);

    expect((await pauseStale(env, NOW)).sort()).toEqual(
      [stale, oldSighting].sort(),
    );
    for (const id of [stale, oldSighting]) {
      expect(await sourceRow(id)).toMatchObject({
        status: "paused",
        paused_reason: "stale",
      });
    }
    for (const id of [young, neverFetched, notFetchedLately, fresh]) {
      expect(await sourceRow(id)).toMatchObject({
        status: "active",
        paused_reason: null,
      });
    }
    expect((await sourceRow(paused))?.paused_reason).toBeNull();
  });

  it("counts sightings since a time (the 7-day metric)", async () => {
    const id = await src(1);
    const a1 = await seedArticle({
      sourceId: id,
      industryId: industry,
      url: "https://a/1",
      stageUpdatedAt: 0,
    });
    const a2 = await seedArticle({
      sourceId: id,
      industryId: industry,
      url: "https://a/2",
      stageUpdatedAt: 0,
    });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO article_sightings VALUES (?1, ?2, ?3)").bind(
        a1,
        id,
        NOW - 6 * DAY,
      ),
      env.DB.prepare("INSERT INTO article_sightings VALUES (?1, ?2, ?3)").bind(
        a2,
        id,
        NOW - 8 * DAY,
      ),
    ]);
    expect(await countSightings(env.DB, id, NOW - 7 * DAY)).toBe(1);
  });
});
