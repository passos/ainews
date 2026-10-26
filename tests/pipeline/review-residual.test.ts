import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import {
  trackEventPrimarySources,
  trackDuePrimarySources,
} from "../../src/pipeline/evidence/primary";
import { syncRevisionDiff } from "../../src/pipeline/evidence/diff";
import { generateEventEvidence } from "../../src/pipeline/evidence/build";
import { generateEventArtifacts } from "../../src/pipeline/artifacts/build";
import { decideReview, reviewClaim } from "../../src/server/admin/ops";
import { MAX_BODY_BYTES } from "../../src/pipeline/body/ladder";
import type { PipelineEnv } from "../../src/pipeline/messages";
import type { ModelClient } from "../../src/providers/models";

let eventId: number;
let articleId: number;
const target = "https://arxiv.org/abs/new-paper";
const markdown =
  "# Primary paper\n\n" +
  "This is a detailed report describing the experimental results and their limitations. ".repeat(
    8,
  );
const mockFetch = vi.fn(async (url: string) =>
  url.includes("robots.txt")
    ? new Response("User-agent: *\nAllow: /", { status: 200 })
    : new Response(markdown, { headers: { "Content-Type": "text/markdown" } }),
);
const models = {
  generateText: async () => ({
    text: JSON.stringify({
      whatHappened: "H",
      whatIsNew: "N",
      whatEvidenceExists: "E",
      whatToWatchNext: "W",
    }),
    finishReason: "STOP",
  }),
} as unknown as ModelClient;

beforeEach(async () => {
  for (const table of [
    "claim_evidence",
    "claims",
    "event_artifacts",
    "event_articles",
    "analyses",
    "reviews",
    "articles",
    "events",
    "sources",
    "fetch_hosts",
    "robots_cache",
  ]) {
    if (["robots_cache"].includes(table)) continue;
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    `INSERT INTO industries (id, slug, name, publish_mode, primary_domains, config, config_version, created_at)
    VALUES (1,'technology','Technology','auto','["arxiv.org"]','{}',1,1000)
    ON CONFLICT(id) DO UPDATE SET publish_mode='auto'`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO sources (id,industry_id,name,feed_url,site_domain,kind,status,created_at)
    VALUES(1,1,'Reporter','https://reporter.test/feed','reporter.test','rss','active',1000)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO sources (industry_id,name,feed_url,site_domain,kind,status,created_at)
    VALUES(1,'arXiv cs.AI','https://rss.arxiv.org/rss/cs.AI','arxiv.org','rss','active',1000)`,
  ).run();
  eventId = (await env.DB.prepare(
    `INSERT INTO events (industry_id,title,revision,created_at,updated_at) VALUES(1,'Event',1,1000,1000) RETURNING id`,
  ).first<{ id: number }>())!.id;
  articleId = (await env.DB.prepare(
    `INSERT INTO articles (source_id,industry_id,canonical_url,url,title,body_sha,stage,stage_updated_at,fetched_at)
    VALUES(1,1,'https://reporter.test/report','https://reporter.test/report','Report','sha','grouped',1000,1000) RETURNING id`,
  ).first<{ id: number }>())!.id;
  await env.DB.prepare(
    `INSERT INTO reviews(article_id,body_sha,decision,reviewer,created_at) VALUES(?,'sha','approved','admin',1000)`,
  )
    .bind(articleId)
    .run();
  await env.DB.prepare(
    `INSERT INTO event_articles(event_id,article_id,input_revision,created_at) VALUES(?,?,1,1000)`,
  )
    .bind(eventId, articleId)
    .run();
  await env.BODIES.put(
    `bodies/${articleId}/sha.md`,
    `Read [paper](${target}).`,
  );
  mockFetch.mockClear();
});

it("first approval assigns article to approval revision", async () => {
  await env.DB.prepare(`DELETE FROM reviews WHERE article_id=?`)
    .bind(articleId)
    .run();
  await decideReview(env.DB, {
    articleId,
    bodySha: "sha",
    decision: "approved",
    reviewer: "admin",
  });
  const row = await env.DB.prepare(
    `SELECT e.revision,ea.input_revision FROM events e JOIN event_articles ea ON ea.event_id=e.id WHERE e.id=?`,
  )
    .bind(eventId)
    .first<{ revision: number; input_revision: number }>();
  expect(row!.input_revision).toBe(row!.revision);
});

it("rechecks existing candidate approval atomically with event linking", async () => {
  const candidate = await env.DB.prepare(
    `INSERT INTO articles(source_id,industry_id,canonical_url,url,title,body_sha,stage,stage_updated_at,fetched_at) VALUES(1,1,?,?,'Candidate','candidate-sha','grouped',1000,1000) RETURNING id`,
  )
    .bind(target, target)
    .first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO reviews(article_id,body_sha,decision,reviewer,created_at) VALUES(?,'candidate-sha','approved','admin',1000)`,
  )
    .bind(candidate!.id)
    .run();
  const interleavedDb = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      await env.DB.prepare(
        `UPDATE reviews SET decision='rejected' WHERE article_id=?`,
      )
        .bind(candidate!.id)
        .run();
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  await trackEventPrimarySources(
    { db: interleavedDb, bodies: env.BODIES, fetch: mockFetch as typeof fetch },
    env,
    eventId,
    ["arxiv.org"],
    1000,
  );
  const link = await env.DB.prepare(
    `SELECT event_id FROM event_articles WHERE article_id=?`,
  )
    .bind(candidate!.id)
    .first();
  expect(link).toBeNull();
});

it("retries primary source after transient R2 put failure", async () => {
  const brokenBodies = {
    get: (key: string) => env.BODIES.get(key),
    put: async () => {
      throw new Error("transient storage failure");
    },
  } as unknown as R2Bucket;
  await trackEventPrimarySources(
    { db: env.DB, bodies: brokenBodies, fetch: mockFetch as typeof fetch },
    env,
    eventId,
    ["arxiv.org"],
    1000,
  );
  const retry = await trackEventPrimarySources(
    { db: env.DB, bodies: env.BODIES, fetch: mockFetch as typeof fetch },
    env,
    eventId,
    ["arxiv.org"],
    2000,
  );
  expect(retry.trackedCount).toBe(1);
});

it("processed URL prefix does not starve a sixth new URL", async () => {
  const urls = Array.from(
    { length: 5 },
    (_, i) => `https://arxiv.org/abs/old-${i}`,
  );
  for (const url of urls)
    await env.DB.prepare(
      `INSERT INTO articles(source_id,industry_id,canonical_url,url,title,stage,stage_updated_at,fetched_at) VALUES(1,1,?,?,?,'dropped',1000,1000)`,
    )
      .bind(url, url, url)
      .run();
  await env.BODIES.put(
    `bodies/${articleId}/sha.md`,
    [...urls, target].map((url) => `[paper](${url})`).join("\n"),
  );
  const result = await trackEventPrimarySources(
    { db: env.DB, bodies: env.BODIES, fetch: mockFetch as typeof fetch },
    env,
    eventId,
    ["arxiv.org"],
    3000,
  );
  expect(result.trackedCount).toBe(1);
});

it("revision one gets diff when extraction legitimately finds no claims", async () => {
  const noClaims = {
    generateText: async () => ({ text: '{"claims":[]}', finishReason: "STOP" }),
  } as unknown as ModelClient;
  const evidence = await generateEventEvidence(
    { ...env, MODEL_CALLS_ENABLED: "true" } as PipelineEnv,
    eventId,
    1000,
    { db: env.DB, bodies: env.BODIES, models: noClaims },
  );
  expect(evidence.status).toBe("generated");
  await generateEventArtifacts(env as PipelineEnv, eventId, 1000, {
    db: env.DB,
    bodies: env.BODIES,
    models,
  });
  const diff = await env.DB.prepare(
    `SELECT id FROM event_artifacts WHERE event_id=? AND type='revision_diff'`,
  )
    .bind(eventId)
    .first();
  expect(diff).not.toBeNull();
});

it("same revision stale sync cannot overwrite completed claims diff", async () => {
  await env.DB.prepare(`UPDATE events SET revision=2 WHERE id=?`)
    .bind(eventId)
    .run();
  let pause!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    pause = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayedDb = {
    prepare(sql: string) {
      const statement = env.DB.prepare(sql);
      if (!sql.includes("INSERT INTO event_artifacts")) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            run: async () => {
              pause();
              await released;
              return bound.run();
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const oldSync = syncRevisionDiff(delayedDb, eventId, 2, "published", 1000);
  await paused;
  await env.DB.prepare(
    `INSERT INTO claims(event_id,claim_text,claim_type,consensus_status,status,input_revision,prompt_version,model,created_at) VALUES(?,'Independent result','fact','verified','published',2,'v1','mock',1000)`,
  )
    .bind(eventId)
    .run();
  await syncRevisionDiff(env.DB, eventId, 2, "published", 1001);
  release();
  await oldSync;
  const diff = await env.DB.prepare(
    `SELECT content FROM event_artifacts WHERE event_id=? AND type='revision_diff'`,
  )
    .bind(eventId)
    .first<{ content: string }>();
  expect(JSON.parse(diff!.content).newClaims).toContain("Independent result");
});

it("manual claim approval refreshes the timeline diff", async () => {
  await env.DB.prepare(`UPDATE events SET revision=2 WHERE id=?`)
    .bind(eventId)
    .run();
  const claim = await env.DB.prepare(
    `INSERT INTO claims(event_id,claim_text,claim_type,consensus_status,status,input_revision,prompt_version,model,created_at) VALUES(?,'Reviewed result','fact','verified','pending_review',2,'v1','mock',1000) RETURNING id`,
  )
    .bind(eventId)
    .first<{ id: number }>();
  await syncRevisionDiff(env.DB, eventId, 2, "pending_review", 1000);
  expect(
    await reviewClaim(env.DB, {
      claimId: claim!.id,
      decision: "approved",
      expectedRevision: 2,
    }),
  ).toBe(true);
  const diff = await env.DB.prepare(
    `SELECT content FROM event_artifacts WHERE event_id=? AND type='revision_diff'`,
  )
    .bind(eventId)
    .first<{ content: string }>();
  expect(JSON.parse(diff!.content).newClaims).toContain("Reviewed result");
});

it("caps converted markdown by UTF-8 bytes", async () => {
  const converted = "# Paper\n\n" + "汉字数据报告 ".repeat(250000);
  const fetchHtml = async (url: string) =>
    url.includes("robots.txt")
      ? new Response("User-agent: *\nAllow: /")
      : new Response("<html>Paper</html>", {
          headers: { "Content-Type": "text/html" },
        });
  await trackEventPrimarySources(
    {
      db: env.DB,
      bodies: env.BODIES,
      fetch: fetchHtml as typeof fetch,
      toMarkdown: async () => converted,
    },
    env,
    eventId,
    ["arxiv.org"],
    1000,
  );
  const row = await env.DB.prepare(
    `SELECT id,body_sha FROM articles WHERE canonical_url=?`,
  )
    .bind(target)
    .first<{ id: number; body_sha: string }>();
  expect(row).not.toBeNull();
  const body = await (await env.BODIES.get(
    `bodies/${row!.id}/${row!.body_sha}.md`,
  ))!.arrayBuffer();
  expect(body.byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
});

function failFirstDiffWrite(): D1Database {
  let failed = false;
  return {
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    prepare(sql: string) {
      const statement = env.DB.prepare(sql);
      if (!sql.includes("INSERT INTO event_artifacts")) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async run() {
              if (!failed) {
                failed = true;
                throw new Error("transient diff write failure");
              }
              return bound.run();
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

it("review probe: UTF-8 complete two-byte boundary stays within body cap", async () => {
  const converted = "é".repeat(MAX_BODY_BYTES / 2) + "x";
  const fetchHtml = async (url: string) =>
    url.includes("robots.txt")
      ? new Response("User-agent: *\nAllow: /")
      : new Response("<html>Paper</html>", {
          headers: { "Content-Type": "text/html" },
        });
  await trackEventPrimarySources(
    {
      db: env.DB,
      bodies: env.BODIES,
      fetch: fetchHtml as typeof fetch,
      toMarkdown: async () => converted,
    },
    env,
    eventId,
    ["arxiv.org"],
    1000,
  );
  const row = await env.DB.prepare(
    "SELECT id,body_sha FROM articles WHERE canonical_url=?",
  )
    .bind(target)
    .first<{ id: number; body_sha: string }>();
  const body = await (await env.BODIES.get(
    `bodies/${row!.id}/${row!.body_sha}.md`,
  ))!.arrayBuffer();
  expect(body.byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
  expect(new TextDecoder().decode(body)).not.toContain("\uFFFD");
});

it("review probe: no-claims retry repairs failed diff sync", async () => {
  const noClaims = {
    generateText: async () => ({ text: '{"claims":[]}', finishReason: "STOP" }),
  } as unknown as ModelClient;
  const enabled = { ...env, MODEL_CALLS_ENABLED: "true" } as PipelineEnv;
  await expect(
    generateEventEvidence(enabled, eventId, 1000, {
      db: failFirstDiffWrite(),
      bodies: env.BODIES,
      models: noClaims,
    }),
  ).rejects.toThrow("transient diff write failure");
  await generateEventEvidence(enabled, eventId, 1001, {
    db: env.DB,
    bodies: env.BODIES,
    models: noClaims,
  });
  await generateEventArtifacts(env as PipelineEnv, eventId, 1001, {
    db: env.DB,
    bodies: env.BODIES,
    models,
  });
  const diff = await env.DB.prepare(
    "SELECT id FROM event_artifacts WHERE event_id=? AND type='revision_diff'",
  )
    .bind(eventId)
    .first();
  expect(diff).not.toBeNull();
});

it("review probe: claim approval retry repairs failed diff sync", async () => {
  await env.DB.prepare("UPDATE events SET revision=2 WHERE id=?")
    .bind(eventId)
    .run();
  const claim = await env.DB.prepare(
    "INSERT INTO claims(event_id,claim_text,claim_type,consensus_status,status,input_revision,prompt_version,model,created_at) VALUES(?,'Reviewed result','fact','verified','pending_review',2,'v1','mock',1000) RETURNING id",
  )
    .bind(eventId)
    .first<{ id: number }>();
  await syncRevisionDiff(env.DB, eventId, 2, "pending_review", 1000);
  const data = {
    claimId: claim!.id,
    decision: "approved" as const,
    expectedRevision: 2,
  };
  await expect(reviewClaim(failFirstDiffWrite(), data)).rejects.toThrow(
    "transient diff write failure",
  );
  await reviewClaim(env.DB, data);
  const diff = await env.DB.prepare(
    "SELECT content FROM event_artifacts WHERE event_id=? AND type='revision_diff'",
  )
    .bind(eventId)
    .first<{ content: string }>();
  expect(JSON.parse(diff!.content).newClaims).toContain("Reviewed result");
});

it("independent review: retry repairs an existing diff after nonempty claim sync failure", async () => {
  const quote = "Independent experiments demonstrate substantial improvements.";
  await env.BODIES.put(`bodies/${articleId}/sha.md`, quote);
  await env.DB.prepare("UPDATE events SET revision=2 WHERE id=?")
    .bind(eventId)
    .run();
  await syncRevisionDiff(env.DB, eventId, 2, "published", 1000);
  const claimModels = {
    generateText: async () => ({
      text: JSON.stringify({
        claims: [
          {
            claimText: "A newly verified result",
            claimType: "fact",
            citations: [
              {
                articleId,
                quote,
                stance: "support",
                sourceRole: "independent",
              },
            ],
          },
        ],
      }),
      finishReason: "STOP",
    }),
  } as unknown as ModelClient;
  const enabled = { ...env, MODEL_CALLS_ENABLED: "true" } as PipelineEnv;
  await expect(
    generateEventEvidence(enabled, eventId, 1000, {
      db: failFirstDiffWrite(),
      bodies: env.BODIES,
      models: claimModels,
    }),
  ).rejects.toThrow("transient diff write failure");
  const claim = await env.DB.prepare(
    "SELECT status FROM claims WHERE event_id=? AND claim_text='A newly verified result'",
  )
    .bind(eventId)
    .first<{ status: string }>();
  expect(claim?.status).toBe("published");
  await generateEventEvidence(enabled, eventId, 1001, {
    db: env.DB,
    bodies: env.BODIES,
    models: claimModels,
  });
  const diff = await env.DB.prepare(
    "SELECT content FROM event_artifacts WHERE event_id=? AND type='revision_diff'",
  )
    .bind(eventId)
    .first<{ content: string }>();
  expect(JSON.parse(diff!.content).newClaims).toContain(
    "A newly verified result",
  );
});

it("independent review: retry recovers a transient primary approval batch failure", async () => {
  let failed = false;
  const failFirstBatch = {
    prepare: (sql: string) => env.DB.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      if (!failed) {
        failed = true;
        throw new Error("transient approval batch failure");
      }
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  await trackEventPrimarySources(
    {
      db: failFirstBatch,
      bodies: env.BODIES,
      fetch: mockFetch as typeof fetch,
    },
    env,
    eventId,
    ["arxiv.org"],
    1000,
  );
  const orphan = await env.DB.prepare(
    "SELECT a.id,a.stage,r.decision FROM articles a LEFT JOIN reviews r ON r.article_id=a.id WHERE a.canonical_url=?",
  )
    .bind(target)
    .first<{ id: number; stage: string; decision: string | null }>();
  expect(orphan?.stage).toBe("grouped");
  expect(orphan?.decision).toBeNull();
  const retry = await trackEventPrimarySources(
    { db: env.DB, bodies: env.BODIES, fetch: mockFetch as typeof fetch },
    env,
    eventId,
    ["arxiv.org"],
    2000,
  );
  expect(retry.trackedCount).toBe(1);
});

it("independent review: preserves an administrator rejection when retrying an orphaned primary article", async () => {
  const target = "https://arxiv.org/abs/review-extra";
  const { seedEvent, seedArticle, seedEventArticle, seedReview } =
    await import("../publication/helpers");
  const tech = { industryId: 1, sourceId: 1 };
  const eventId = await seedEvent(tech.industryId, "Event", 1);
  const report = await seedArticle({ ...tech, title: "Report" });
  await seedEventArticle(eventId, report, 1000, 1);
  await seedReview(report, "approved");
  await env.BODIES.put(
    `bodies/${report}/sha-current.md`,
    `Read [paper](${target}).`,
  );
  const markdown =
    "# Paper\n\n" + "Detailed findings and research limitations. ".repeat(30);
  const mockFetch = vi.fn(async (url: string) =>
    url.includes("robots.txt")
      ? new Response("User-agent: *\nAllow: /", { status: 200 })
      : new Response(markdown, {
          headers: { "Content-Type": "text/markdown" },
        }),
  );
  const failingDb = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async () => {
      throw new Error("transient approval batch failure");
    },
  } as unknown as D1Database;
  await trackEventPrimarySources(
    { db: failingDb, bodies: env.BODIES, fetch: mockFetch as typeof fetch },
    env,
    eventId,
    ["arxiv.org"],
    1000,
  );
  const orphan = (await env.DB.prepare(
    "SELECT id,stage,body_sha FROM articles WHERE canonical_url=?",
  )
    .bind(target)
    .first<{ id: number; stage: string; body_sha: string }>())!;
  expect(orphan.stage).toBe("grouped");
  expect(
    await env.DB.prepare("SELECT 1 FROM event_articles WHERE article_id=?")
      .bind(orphan.id)
      .first(),
  ).toBeNull();
  await decideReview(env.DB, {
    articleId: orphan.id,
    bodySha: orphan.body_sha,
    decision: "rejected",
    reviewer: "admin",
  });
  await trackEventPrimarySources(
    { db: env.DB, bodies: env.BODIES, fetch: mockFetch as typeof fetch },
    env,
    eventId,
    ["arxiv.org"],
    2000,
  );
  const review = await env.DB.prepare(
    "SELECT decision FROM reviews WHERE article_id=? AND body_sha=?",
  )
    .bind(orphan.id, orphan.body_sha)
    .first<{ decision: string }>();
  const link = await env.DB.prepare(
    "SELECT event_id FROM event_articles WHERE article_id=?",
  )
    .bind(orphan.id)
    .first();
  expect({ decision: review!.decision, link }).toEqual({
    decision: "rejected",
    link: null,
  });
});

it("independent review: eventually scans the oldest eligible event when eleven events are eligible", async () => {
  const { seedEvent, seedArticle, seedEventArticle, seedReview } =
    await import("../publication/helpers");
  const tech = { industryId: 1, sourceId: 1 };
  await env.DB.prepare(
    "UPDATE industries SET primary_domains='[\"arxiv.org\"]' WHERE id=?",
  )
    .bind(tech.industryId)
    .run();
  let oldestArticle = 0;
  for (let i = 0; i < 11; i++) {
    const eventId = await seedEvent(tech.industryId, `Event ${i}`, 1);
    await env.DB.prepare("UPDATE events SET updated_at=? WHERE id=?")
      .bind(i, eventId)
      .run();
    const article = await seedArticle({ ...tech, title: `Report ${i}` });
    await seedEventArticle(eventId, article, i, 1);
    await seedReview(article, "approved");
    if (i === 0) oldestArticle = article;
  }
  // Return no body so this scheduling probe makes no outbound requests.
  const scannedKeys: string[] = [];
  const get = vi.fn(async (key: string) => {
    scannedKeys.push(key);
    return null;
  });
  const scheduledEnv = {
    ...env,
    COLLECT_ENABLED: "true",
    BODIES: { get },
  } as unknown as PipelineEnv;
  for (let i = 0; i < 3; i++)
    await trackDuePrimarySources(scheduledEnv, 1000 + i * 600000);
  expect(get).toHaveBeenCalledTimes(30);
  expect(scannedKeys).toContain(`bodies/${oldestArticle}/sha-current.md`);
});
