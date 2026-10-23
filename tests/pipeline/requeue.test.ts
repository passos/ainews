import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { requeueStuck } from "../../src/pipeline/requeue";
import {
  count,
  fakeQueue,
  MIN,
  NOW,
  pipelineEnv,
  resetPipeline,
  seedArticle,
  seedIndustry,
  seedSource,
} from "./helpers";

const ALL_ON = { COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true" };
let industry: number;
let source: number;
let n = 0;
const article = (stage: string, ageMin: number, requeueCount = 0) =>
  seedArticle({
    sourceId: source,
    industryId: industry,
    url: `https://a.example/${(n += 1)}`,
    stage,
    stageUpdatedAt: NOW - ageMin * MIN,
    requeueCount,
  });
const requeueCount = (id: number) =>
  count("SELECT requeue_count AS n FROM articles WHERE id = ?1", id);

beforeEach(async () => {
  await resetPipeline();
  industry = await seedIndustry("ai");
  source = await seedSource({
    industryId: industry,
    feedUrl: "https://s.example/feed",
  });
});

describe("requeueStuck", () => {
  it("sends body again for a collected row stuck 31 minutes, once per 30 minutes", async () => {
    const id = await article("collected", 31);
    await article("collected", 29);
    const q = fakeQueue();
    const e = pipelineEnv(q, ALL_ON);
    expect(await requeueStuck(e, NOW)).toEqual([id]);
    expect(q.sent).toEqual([{ kind: "body", articleId: id }]);
    expect(await requeueCount(id)).toBe(1);
    // stage_updated_at moved to now: not stuck again until 30 minutes later.
    expect(await requeueStuck(e, NOW + 1)).toEqual([]);
    expect(await requeueStuck(e, NOW + 31 * MIN)).toContain(id);
    expect(await requeueCount(id)).toBe(2);
  });

  it("stops after 3 requeues", async () => {
    const two = await article("collected", 31, 2);
    await article("collected", 31, 3);
    const q = fakeQueue();
    expect(await requeueStuck(pipelineEnv(q, ALL_ON), NOW)).toEqual([two]);
    expect(await requeueCount(two)).toBe(3);
    expect(await requeueStuck(pipelineEnv(q, ALL_ON), NOW + 31 * MIN)).toEqual(
      [],
    );
  });

  it("sends analyze for body_ready; never for analyzed, grouped or dropped", async () => {
    const ready = await article("body_ready", 31);
    for (const stage of ["analyzed", "grouped", "dropped"])
      await article(stage, 31);
    const q = fakeQueue();
    expect(await requeueStuck(pipelineEnv(q, ALL_ON), NOW)).toEqual([ready]);
    expect(q.sent).toEqual([{ kind: "analyze", articleId: ready }]);
  });

  it("skips a stage while the flag of its next step is off", async () => {
    const collected = await article("collected", 31);
    const ready = await article("body_ready", 31);
    const q = fakeQueue();
    expect(
      await requeueStuck(pipelineEnv(q, { COLLECT_ENABLED: "true" }), NOW),
    ).toEqual([collected]);
    expect(
      await requeueStuck(pipelineEnv(q, { MODEL_CALLS_ENABLED: "true" }), NOW),
    ).toEqual([ready]);
    expect(await requeueStuck(pipelineEnv(q), NOW + 31 * MIN)).toEqual([]);
    expect(q.sent).toHaveLength(2);
    const { results } = await env.DB.prepare(
      "SELECT requeue_count FROM articles ORDER BY id",
    ).all();
    expect(results).toEqual([{ requeue_count: 1 }, { requeue_count: 1 }]);
  });
});
