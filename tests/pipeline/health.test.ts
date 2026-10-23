// "No new content for a long time" counts fetches, not calendar time.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { collectSource } from "../../src/pipeline/collect/collect";
import { STALE_AFTER_MINUTES } from "../../src/pipeline/collect/health";
import {
  fakeFetch,
  fakeQueue,
  NOW,
  ON,
  pipelineEnv,
  resetPipeline,
  seedIndustry,
  seedSource,
  sourceRow,
} from "./helpers";

// One day per fetch: 30 empty fetches pause the source.
const INTERVAL = 24 * 60;
const N = Math.ceil(STALE_AFTER_MINUTES / INTERVAL);
const FEED = "https://h.example/feed";
const rss =
  (...urls: string[]) =>
  () =>
    new Response(
      `<?xml version="1.0"?><rss version="2.0"><channel>${urls
        .map((u) => `<item><title>${u}</title><link>${u}</link></item>`)
        .join("")}</channel></rss>`,
    );
const notModified = () => new Response(null, { status: 304 });

let industry: number;
let source: number;
beforeEach(async () => {
  await resetPipeline();
  industry = await seedIndustry("ai");
  source = await seedSource({
    industryId: industry,
    feedUrl: FEED,
    intervalMinutes: INTERVAL,
  });
});

const run = (respond: () => Response, id = source) =>
  collectSource(pipelineEnv(fakeQueue(), ON), id, NOW, fakeFetch(respond));

describe("empty fetches", () => {
  it("pauses as stale on the Nth empty fetch, not on the N-1th", async () => {
    expect(N).toBe(30);
    await run(rss("https://h.example/1"));
    for (let i = 1; i < N; i++) {
      // 200 with only known entries and 304 are both empty.
      await run(i % 2 ? notModified : rss("https://h.example/1"));
    }
    expect(await sourceRow(source)).toMatchObject({
      status: "active",
      paused_reason: null,
      empty_fetches: N - 1,
    });
    await run(notModified);
    expect(await sourceRow(source)).toMatchObject({
      status: "paused",
      paused_reason: "stale",
      empty_fetches: N,
    });
  });

  it("uses interval_minutes: a weekly source pauses after 5 empty fetches", async () => {
    const weekly = await seedSource({
      industryId: industry,
      feedUrl: "https://w.example/feed",
      intervalMinutes: 7 * 24 * 60,
      emptyFetches: 4,
    });
    await run(notModified, weekly);
    expect(await sourceRow(weekly)).toMatchObject({
      status: "paused",
      paused_reason: "stale",
    });
  });

  it("resets to 0 when the source sees an article for the first time", async () => {
    await env.DB.prepare("UPDATE sources SET empty_fetches = ?1 WHERE id = ?2")
      .bind(N - 1, source)
      .run();
    await run(rss("https://h.example/new"));
    expect((await sourceRow(source))?.empty_fetches).toBe(0);
    // Another source's article that this source sees first: also new for it.
    const other = await seedSource({
      industryId: industry,
      feedUrl: "https://o.example/feed",
      intervalMinutes: INTERVAL,
    });
    await env.DB.prepare("UPDATE sources SET empty_fetches = ?1 WHERE id = ?2")
      .bind(N - 1, other)
      .run();
    await run(rss("https://h.example/new"), other);
    expect(await sourceRow(other)).toMatchObject({
      status: "active",
      empty_fetches: 0,
    });
  });

  it("does not change empty_fetches on a failed fetch", async () => {
    await env.DB.prepare("UPDATE sources SET empty_fetches = ?1 WHERE id = ?2")
      .bind(N - 1, source)
      .run();
    await run(() => new Response("", { status: 500 }));
    expect(await sourceRow(source)).toMatchObject({
      status: "active",
      empty_fetches: N - 1,
      fail_count: 1,
    });
  });
});
