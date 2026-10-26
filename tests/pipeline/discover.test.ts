import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { runDiscovery } from "../../src/pipeline/discover/run";
import { draftIndustryConfig } from "../../src/pipeline/discover/draft";
import {
  probeCandidate,
  isBrowserRequired,
} from "../../src/pipeline/discover/probe";
import { evaluateCandidateSamples } from "../../src/pipeline/discover/score";
import { handleGenerateBatch } from "../../src/pipeline/generate/consumer";
import {
  discoveryRuns,
  sourceCandidates,
  sources,
  industries,
} from "../../src/server/db/schema";
import {
  analysisConfigSchema,
  type AnalysisConfig,
} from "../../src/pipeline/analyze/config";
import {
  BudgetExceededError,
  type ModelClient,
} from "../../src/providers/models";
import type { GenerateMessage } from "../../src/pipeline/messages";

const SAMPLE_ANALYSIS_CONFIG = {
  prefilter: {
    relevant: "Material about biotechnology innovations.",
    off_topic: "Material unrelated to biology.",
    noise: "Promotions, marketing, spam.",
  },
  categories: {
    therapeutics: "New drugs and therapies",
    genomics: "Gene editing and sequencing",
  },
  contentTypes: {
    research: {
      description: "Primary scientific paper or trial",
      weights: { sig: 2, nov: 2, cred: 2, reson: 2, act: 2 },
    },
  },
  dimensions: {
    sig: ["t1", "t2", "t3", "t4", "t5"],
    nov: ["t1", "t2", "t3", "t4", "t5"],
    cred: ["t1", "t2", "t3", "t4", "t5"],
    reson: ["t1", "t2", "t3", "t4", "t5"],
    act: ["t1", "t2", "t3", "t4", "t5"],
  },
  noise: {
    none: {
      description: "No noise",
      caps: {},
    },
  },
  labels: ["claim_mode", "development_stage"],
  thresholds: {
    prefilterMinRelevant: 0.3,
    select: 60,
  },
  summaryGuidance: "Summarize findings clearly.",
  guardrails: ["Verify data", "Check controls"],
};

describe("Pipeline: Source Discovery & Auto-Enable", () => {
  it("DISCOVERY_ENABLED = false halts execution without making search or model calls", async () => {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug: "disc-guard",
        name: "Discovery Guard Section",
        publishMode: "review",
        config: JSON.stringify({ analysis: SAMPLE_ANALYSIS_CONFIG }),
        createdAt: 1000,
      })
      .returning({ id: industries.id });

    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        createdAt: 1000,
      })
      .returning({ id: discoveryRuns.id });

    const searchMock = vi.fn();
    const generateTextMock = vi.fn();

    // Call with env having DISCOVERY_ENABLED: "false"
    const fakeEnv = {
      ...env,
      DISCOVERY_ENABLED: "false",
    };

    await runDiscovery(fakeEnv, run[0].id, 2000, {
      webSearch: { search: searchMock as unknown as WebSearch["search"] },
      models: {
        generateText:
          generateTextMock as unknown as ModelClient["generateText"],
      } as unknown as ModelClient,
    });

    expect(searchMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();

    const updated = await db
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.id, run[0].id));
    expect(updated[0].status).toBe("skipped");
    expect(updated[0].error).toContain("DISCOVERY_ENABLED is false");
  });

  it("identifies JS challenge / Cloudflare wall and rejects candidate as requiresBrowser = 1", async () => {
    const wallHtml = `
      <html>
        <head><title>Just a moment...</title></head>
        <body>
          <div id="challenge-running">Checking your browser before accessing example.com</div>
          <div class="cf-turnstile"></div>
        </body>
      </html>
    `;

    expect(isBrowserRequired(wallHtml)).toBe(true);

    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      return new Response(wallHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    };

    const probe = await probeCandidate("https://wall-site.com", env, {
      fetch: fakeFetch,
      now: () => 1000,
    });

    expect(probe.requiresBrowser).toBe(1);
    expect(probe.rejectionReason).toBe("requires_browser");
  });

  it("runDiscovery rejects candidates requiring browser and never auto-enables them", async () => {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug: "browser-wall-sec",
        name: "Wall Section",
        publishMode: "review",
        config: JSON.stringify({ analysis: SAMPLE_ANALYSIS_CONFIG }),
        createdAt: 1000,
      })
      .returning({ id: industries.id });

    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        searchQueries: JSON.stringify(["wall feed"]),
        createdAt: 1000,
      })
      .returning({ id: discoveryRuns.id });

    const wallHtml = `
      <html>
        <head><title>Just a moment...</title></head>
        <body>
          <div id="challenge-running">Checking your browser</div>
          <div class="cf-turnstile"></div>
        </body>
      </html>
    `;

    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      return new Response(wallHtml, { status: 200 });
    };

    const fakeWebSearch: WebSearch = {
      search: async () => ({
        items: [{ url: "https://wall-site.com", title: "Wall Site" }],
        metadata: { query: "wall feed", requestId: "r", latencyMs: 5 },
      }),
    };

    await runDiscovery({ ...env, DISCOVERY_ENABLED: "true" }, run[0].id, 1000, {
      webSearch: fakeWebSearch,
      fetch: fakeFetch,
    });

    const candidates = await db
      .select()
      .from(sourceCandidates)
      .where(eq(sourceCandidates.runId, run[0].id));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("rejected");
    expect(candidates[0].requiresBrowser).toBe(1);
    expect(candidates[0].rejectionReason).toBe("requires_browser");

    const created = await db
      .select()
      .from(sources)
      .where(eq(sources.siteDomain, "wall-site.com"));
    expect(created).toHaveLength(0);
  });

  it("auto-enables high-scoring non-finance candidates when active sources < 50", async () => {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug: "auto-tech",
        name: "Auto Tech Section",
        publishMode: "review",
        config: JSON.stringify({ analysis: SAMPLE_ANALYSIS_CONFIG }),
        createdAt: 1000,
      })
      .returning({ id: industries.id });

    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        searchQueries: JSON.stringify(["tech feed"]),
        createdAt: 1000,
      })
      .returning({ id: discoveryRuns.id });

    const fakeRss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <title>Good Tech Blog</title>
          <link>https://goodtech.com</link>
          <item>
            <title>Revolutionary Breakthrough in AI</title>
            <link>https://goodtech.com/post-1</link>
            <content:encoded><![CDATA[Detailed scientific analysis of the breakthrough with extensive data and evaluation results demonstrating clear superiority across all benchmark tests. It contains enough characters to satisfy the minimum length requirement easily.]]></content:encoded>
          </item>
        </channel>
      </rss>`;

    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      return new Response(fakeRss, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      });
    };

    const fakeWebSearch: WebSearch = {
      search: async () => ({
        items: [
          {
            url: "https://goodtech.com/feed.xml",
            title: "Good Tech Feed",
          },
        ],
        metadata: {
          query: "tech feed",
          requestId: "req-1",
          latencyMs: 10,
        },
      }),
    };

    const fakeModels = {
      judge: (async () => ({
        relevance: {
          score: 3.8,
          confidence: 0.9,
          probabilities: { "3": 0.2, "4": 0.8 }, // expectedTier = 3*0.2 + 4*0.8 = 3.8 -> 95/100
        },
      })) as unknown as ModelClient["judge"],
    };

    const fakeEnv = {
      ...env,
      DISCOVERY_ENABLED: "true",
    };

    await runDiscovery(fakeEnv, run[0].id, 1000, {
      webSearch: fakeWebSearch,
      models: fakeModels as unknown as ModelClient,
      fetch: fakeFetch,
    });

    const runAfter = (
      await db
        .select()
        .from(discoveryRuns)
        .where(eq(discoveryRuns.id, run[0].id))
    )[0];
    expect(runAfter.status).toBe("completed");
    expect(runAfter.candidatesAutoEnabled).toBe(1);

    const candidates = await db
      .select()
      .from(sourceCandidates)
      .where(eq(sourceCandidates.runId, run[0].id));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("auto_enabled");
    expect(candidates[0].avgScore).toBeGreaterThanOrEqual(60);

    // Verify source is activated in sources table
    const createdSources = await db
      .select()
      .from(sources)
      .where(eq(sources.feedUrl, "https://goodtech.com/feed.xml"));
    expect(createdSources).toHaveLength(1);
    expect(createdSources[0].status).toBe("active");
  });

  it.each([
    [
      "found through a page feed link",
      ["https://sneaky-a.example/", "https://sneaky-b.example/"],
    ],
    ["returned by search as the URL itself", ["system:foo", "SYSTEM:foo"]],
  ])(
    "never writes a system: feed as candidate or source (%s)",
    async (_case, searchUrls) => {
      const db = drizzle(env.DB);
      const slug = `sys-guard-${searchUrls[0].length}`;
      const ind = await db
        .insert(industries)
        .values({
          slug,
          name: "System Guard Section",
          publishMode: "review",
          config: JSON.stringify({ analysis: SAMPLE_ANALYSIS_CONFIG }),
          createdAt: 1000,
        })
        .returning({ id: industries.id });
      const run = await db
        .insert(discoveryRuns)
        .values({
          industryId: ind[0].id,
          status: "pending",
          searchQueries: JSON.stringify(["tech feed"]),
          createdAt: 1000,
        })
        .returning({ id: discoveryRuns.id });

      const fakeRss = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
          <channel>
            <title>Sneaky Feed</title>
            <link>https://sneaky-a.example</link>
            <item>
              <title>Revolutionary Breakthrough in AI</title>
              <link>https://sneaky-a.example/post-1</link>
              <content:encoded><![CDATA[Detailed scientific analysis of the breakthrough with extensive data and evaluation results demonstrating clear superiority across all benchmark tests. It contains enough characters to satisfy the minimum length requirement easily.]]></content:encoded>
            </item>
          </channel>
        </rss>`;
      // Each page links its feed to a system: URL; every feed URL serves RSS.
      const pageLinks: Record<string, string> = {
        "https://sneaky-a.example/": "system:foo",
        "https://sneaky-b.example/": "SYSTEM:foo",
      };
      const fakeFetch: typeof fetch = async (url) => {
        const u = String(url);
        if (u.endsWith("/robots.txt")) {
          return new Response("User-agent: *\nAllow: /", { status: 200 });
        }
        const link = pageLinks[u];
        if (link) {
          return new Response(
            `<html><head><title>Sneaky</title><link rel="alternate" type="application/rss+xml" href="${link}"></head><body></body></html>`,
            { status: 200, headers: { "Content-Type": "text/html" } },
          );
        }
        return new Response(fakeRss, {
          status: 200,
          headers: { "Content-Type": "application/rss+xml" },
        });
      };
      const fakeWebSearch: WebSearch = {
        search: async () => ({
          items: searchUrls.map((url) => ({ url, title: "Sneaky" })),
          metadata: { query: "tech feed", requestId: "req-1", latencyMs: 10 },
        }),
      };
      const fakeModels = {
        judge: (async () => ({
          relevance: {
            score: 3.8,
            confidence: 0.9,
            probabilities: { "3": 0.2, "4": 0.8 },
          },
        })) as unknown as ModelClient["judge"],
      };

      await runDiscovery(
        { ...env, DISCOVERY_ENABLED: "true" },
        run[0].id,
        1000,
        {
          webSearch: fakeWebSearch,
          models: fakeModels as unknown as ModelClient,
          fetch: fakeFetch,
        },
      );

      const candidates = await db
        .select({ feedUrl: sourceCandidates.feedUrl })
        .from(sourceCandidates)
        .where(eq(sourceCandidates.industryId, ind[0].id));
      expect(candidates).toEqual([]);
      const written = await db
        .select({ feedUrl: sources.feedUrl })
        .from(sources)
        .where(eq(sources.industryId, ind[0].id));
      expect(written).toEqual([]);
    },
  );

  async function discoverWith(
    slug: string,
    searchUrls: string[],
    fetchFn: typeof fetch,
    rawItems?: unknown[],
  ) {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug,
        name: `Section ${slug}`,
        publishMode: "review",
        config: JSON.stringify({ analysis: SAMPLE_ANALYSIS_CONFIG }),
        createdAt: 1000,
      })
      .returning({ id: industries.id });
    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        searchQueries: JSON.stringify(["tech feed"]),
        createdAt: 1000,
      })
      .returning({ id: discoveryRuns.id });
    const fakeWebSearch: WebSearch = {
      search: async () => ({
        items: (rawItems ??
          searchUrls.map((url) => ({ url, title: "Result" }))) as never,
        metadata: { query: "tech feed", requestId: "req-1", latencyMs: 10 },
      }),
    };
    const fakeModels = {
      judge: (async () => ({
        relevance: {
          score: 3.8,
          confidence: 0.9,
          probabilities: { "3": 0.2, "4": 0.8 },
        },
      })) as unknown as ModelClient["judge"],
    };
    await runDiscovery({ ...env, DISCOVERY_ENABLED: "true" }, run[0].id, 1000, {
      webSearch: fakeWebSearch,
      models: fakeModels as unknown as ModelClient,
      fetch: fetchFn,
    });
    return ind[0].id;
  }

  it("does not fetch or touch fetch_hosts for a system: search result", async () => {
    let fetchCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCalls++;
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    };
    const hosts = async () =>
      (await env.DB.prepare("SELECT count(*) n FROM fetch_hosts").first<{
        n: number;
      }>())!.n;
    const before = await hosts();

    await discoverWith("sys-no-probe", ["system:foo", "SYSTEM:foo"], fakeFetch);

    expect(fetchCalls).toBe(0);
    expect(await hosts()).toBe(before);
  });

  it("a search result without a string url does not lose the other results", async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <title>Bad Item Feed</title>
          <link>https://baditem.example</link>
          <item>
            <title>Revolutionary Breakthrough in AI</title>
            <link>https://baditem.example/post-1</link>
            <content:encoded><![CDATA[Detailed scientific analysis of the breakthrough with extensive data and evaluation results demonstrating clear superiority across all benchmark tests. It contains enough characters to satisfy the minimum length requirement easily.]]></content:encoded>
          </item>
        </channel>
      </rss>`;
    const fakeFetch: typeof fetch = async (url) =>
      String(url).endsWith("/robots.txt")
        ? new Response("User-agent: *\nAllow: /", { status: 200 })
        : new Response(rss, {
            status: 200,
            headers: { "Content-Type": "application/rss+xml" },
          });

    const industryId = await discoverWith("bad-item", [], fakeFetch, [
      { title: "no url" },
      { url: 42, title: "number url" },
      { url: null, title: "null url" },
      { url: "https://baditem.example/feed.xml", title: "good" },
    ]);

    const db = drizzle(env.DB);
    const written = await db
      .select({ feedUrl: sources.feedUrl, status: sources.status })
      .from(sources)
      .where(eq(sources.industryId, industryId));
    expect(written).toEqual([
      { feedUrl: "https://baditem.example/feed.xml", status: "active" },
    ]);
  });

  it("stores a trimmed feed_url for a padded search result", async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <title>Padded Feed</title>
          <link>https://padded.example</link>
          <item>
            <title>Revolutionary Breakthrough in AI</title>
            <link>https://padded.example/post-1</link>
            <content:encoded><![CDATA[Detailed scientific analysis of the breakthrough with extensive data and evaluation results demonstrating clear superiority across all benchmark tests. It contains enough characters to satisfy the minimum length requirement easily.]]></content:encoded>
          </item>
        </channel>
      </rss>`;
    const fakeFetch: typeof fetch = async (url) =>
      String(url).endsWith("/robots.txt")
        ? new Response("User-agent: *\nAllow: /", { status: 200 })
        : new Response(rss, {
            status: 200,
            headers: { "Content-Type": "application/rss+xml" },
          });

    const industryId = await discoverWith(
      "padded-feed",
      ["  https://padded.example/feed.xml  "],
      fakeFetch,
    );

    const db = drizzle(env.DB);
    const candidates = await db
      .select({
        feedUrl: sourceCandidates.feedUrl,
        status: sourceCandidates.status,
      })
      .from(sourceCandidates)
      .where(eq(sourceCandidates.industryId, industryId));
    expect(candidates).toEqual([
      { feedUrl: "https://padded.example/feed.xml", status: "auto_enabled" },
    ]);
    const written = await db
      .select({ feedUrl: sources.feedUrl, status: sources.status })
      .from(sources)
      .where(eq(sources.industryId, industryId));
    expect(written).toEqual([
      { feedUrl: "https://padded.example/feed.xml", status: "active" },
    ]);
  });

  it("enforces 50 active sources cap: marks candidate as pending with active_cap_reached", async () => {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug: "cap-section",
        name: "Capped Section",
        publishMode: "review",
        config: JSON.stringify({ analysis: SAMPLE_ANALYSIS_CONFIG }),
        createdAt: 1000,
      })
      .returning({ id: industries.id });

    // Seed 50 active sources
    const batchInserts = [];
    for (let i = 1; i <= 50; i++) {
      batchInserts.push(
        env.DB.prepare(
          `INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at)
           VALUES (?1, ?2, ?3, 'rss', 'active', 1000)`,
        ).bind(ind[0].id, `Source ${i}`, `https://src${i}.com/feed`),
      );
    }
    await env.DB.batch(batchInserts);

    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        searchQueries: JSON.stringify(["feed query"]),
        createdAt: 1000,
      })
      .returning({ id: discoveryRuns.id });

    const fakeRss = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <title>Extra 51st Source</title>
          <item>
            <title>High Quality Article</title>
            <link>https://extra51.com/post</link>
            <content:encoded><![CDATA[Detailed scientific analysis of the breakthrough with extensive data and evaluation results demonstrating clear superiority across all benchmark tests. It contains enough characters to satisfy the minimum length requirement easily, with additional explanations to ensure it exceeds the two hundred characters threshold comfortably.]]></content:encoded>
          </item>
        </channel>
      </rss>`;

    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      return new Response(fakeRss, { status: 200 });
    };

    const fakeWebSearch: WebSearch = {
      search: async () => ({
        items: [{ url: "https://extra51.com/rss", title: "51st Feed" }],
        metadata: { query: "q", requestId: "r", latencyMs: 5 },
      }),
    };

    const fakeModels = {
      judge: (async () => ({
        relevance: {
          score: 4,
          confidence: 1.0,
          probabilities: { "4": 1.0 }, // 100/100 score
        },
      })) as unknown as ModelClient["judge"],
    };

    await runDiscovery({ ...env, DISCOVERY_ENABLED: "true" }, run[0].id, 1000, {
      webSearch: fakeWebSearch,
      models: fakeModels as unknown as ModelClient,
      fetch: fakeFetch,
    });

    const candidates = await db
      .select()
      .from(sourceCandidates)
      .where(eq(sourceCandidates.runId, run[0].id));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].rejectionReason).toBe("active_cap_reached");

    // Source must NOT be inserted into sources
    const extraSource = await db
      .select()
      .from(sources)
      .where(eq(sources.feedUrl, "https://extra51.com/rss"));
    expect(extraSource).toHaveLength(0);
  });

  it("enforces Finance section rule: NEVER auto-enables candidates, stays pending", async () => {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug: "finance",
        name: "Finance & Markets",
        publishMode: "review",
        disclaimer: "Strict financial disclaimer",
        config: JSON.stringify({ analysis: SAMPLE_ANALYSIS_CONFIG }),
        createdAt: 1000,
      })
      .returning({ id: industries.id });

    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        searchQueries: JSON.stringify(["finance feed"]),
        createdAt: 1000,
      })
      .returning({ id: discoveryRuns.id });

    const fakeRss = `<?xml version="1.0"?>
      <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel>
          <title>Wall Street Journal</title>
          <item>
            <title>Fed Interest Rate Decision</title>
            <link>https://wsj.com/post</link>
            <content:encoded><![CDATA[Detailed scientific analysis of the breakthrough with extensive data and evaluation results demonstrating clear superiority across all benchmark tests. It contains enough characters to satisfy the minimum length requirement easily, with additional financial statistics and market indices.]]></content:encoded>
          </item>
        </channel>
      </rss>`;

    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      return new Response(fakeRss, { status: 200 });
    };

    const fakeWebSearch: WebSearch = {
      search: async () => ({
        items: [{ url: "https://wsj.com/feed.xml", title: "WSJ Feed" }],
        metadata: { query: "q", requestId: "r", latencyMs: 5 },
      }),
    };

    const fakeModels = {
      judge: (async () => ({
        relevance: {
          score: 4,
          confidence: 1.0,
          probabilities: { "4": 1.0 }, // 100/100 score
        },
      })) as unknown as ModelClient["judge"],
    };

    await runDiscovery({ ...env, DISCOVERY_ENABLED: "true" }, run[0].id, 1000, {
      webSearch: fakeWebSearch,
      models: fakeModels as unknown as ModelClient,
      fetch: fakeFetch,
    });

    const candidates = await db
      .select()
      .from(sourceCandidates)
      .where(eq(sourceCandidates.runId, run[0].id));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("pending");
    expect(candidates[0].rejectionReason).toBe("finance_requires_review");

    // Must not be auto-enabled
    const src = await db
      .select()
      .from(sources)
      .where(eq(sources.feedUrl, "https://wsj.com/feed.xml"));
    expect(src).toHaveLength(0);
  });

  it("handles BudgetExceededError gracefully without throwing to DLQ", async () => {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug: "budget-section",
        name: "Budget Test Section",
        publishMode: "review",
        config: JSON.stringify({ analysis: SAMPLE_ANALYSIS_CONFIG }),
        createdAt: 1000,
      })
      .returning({ id: industries.id });

    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        createdAt: 1000,
      })
      .returning({ id: discoveryRuns.id });

    const fakeModels: Partial<ModelClient> = {
      generateText: async () => {
        throw new BudgetExceededError("gateway", "2026-10-24", 5000);
      },
    };

    const fakeWebSearch: WebSearch = {
      search: async () => ({
        items: [],
        metadata: { query: "q", requestId: "r", latencyMs: 5 },
      }),
    };

    // runDiscovery must resolve without throwing!
    await expect(
      runDiscovery({ ...env, DISCOVERY_ENABLED: "true" }, run[0].id, 1000, {
        models: fakeModels as unknown as ModelClient,
        webSearch: fakeWebSearch,
      }),
    ).resolves.toBeUndefined();

    const runAfter = (
      await db
        .select()
        .from(discoveryRuns)
        .where(eq(discoveryRuns.id, run[0].id))
    )[0];
    expect(runAfter.status).toBe("failed");
    expect(runAfter.error).toContain("budget gateway");
  });

  it("draftIndustryConfig generates valid AnalysisConfig passing analysisConfigSchema", async () => {
    const fakeReasonOutput = JSON.stringify({
      name: "Quantum Computing",
      slug: "quantum",
      disclaimer: null,
      primaryDomains: ["quantum-journal.org", "arxiv.org"],
      analysis: {
        prefilter: {
          relevant:
            "Qubits, quantum hardware, quantum algorithms, error correction.",
          off_topic: "Classical computing only, general science.",
          noise: "Hype with no technical claims, stock marketing.",
        },
        categories: {
          hardware: "QPU designs and superconducting chips",
          algorithms: "Quantum algorithms and software",
        },
        contentTypes: {
          paper: {
            description: "Research paper on quantum physics",
            weights: { sig: 3, nov: 2, cred: 2, reson: 2, act: 1 },
          },
        },
        dimensions: {
          sig: ["d1", "d2", "d3", "d4", "d5"],
          nov: ["d1", "d2", "d3", "d4", "d5"],
          cred: ["d1", "d2", "d3", "d4", "d5"],
          reson: ["d1", "d2", "d3", "d4", "d5"],
          act: ["d1", "d2", "d3", "d4", "d5"],
        },
        noise: {
          none: { description: "Clean content", caps: {} },
        },
        labels: ["claim_mode", "publication_status"],
        thresholds: {
          prefilterMinRelevant: 0.3,
          select: 55,
        },
        summaryGuidance: "Focus on quantum fidelity and qubit counts.",
        guardrails: ["Never exaggerate quantum supremacy claims."],
      },
    });

    const fakeModels = {
      generateText: (async () => ({
        text: fakeReasonOutput,
        usage: { inputTokens: 100, outputTokens: 200 },
      })) as unknown as ModelClient["generateText"],
    };

    // Throws when DISCOVERY_ENABLED is disabled
    await expect(
      draftIndustryConfig(
        {
          db: env.DB,
          env: { ...env, DISCOVERY_ENABLED: "false" },
          models: fakeModels as unknown as ModelClient,
        },
        {
          description: "Quantum tech",
        },
      ),
    ).rejects.toThrow("DISCOVERY_ENABLED is disabled");

    const draft = await draftIndustryConfig(
      {
        db: env.DB,
        env: { ...env, DISCOVERY_ENABLED: "true" },
        models: fakeModels as unknown as ModelClient,
      },
      {
        description:
          "Everything about quantum hardware, qubits, and algorithms.",
        name: "Quantum Tech",
      },
    );

    expect(draft.name).toBe("Quantum Computing");
    expect(draft.slug).toBe("quantum");
    expect(draft.primaryDomains).toContain("quantum-journal.org");

    // Strictly test schema parse
    const parseResult = analysisConfigSchema.safeParse(draft.analysis);
    expect(parseResult.success).toBe(true);
  });

  it("isBrowserRequired accurately distinguishes GTM/analytics from JS challenge wall", () => {
    // Normal page with script and GTM noscript
    const gtmPage = `
      <!DOCTYPE html>
      <html>
        <head>
          <script type="text/javascript" src="/analytics.js"></script>
        </head>
        <body>
          <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-1234"></iframe></noscript>
          <h1>Real Title</h1>
          <p>Real content here...</p>
        </body>
      </html>
    `;
    expect(isBrowserRequired(gtmPage)).toBe(false);

    // JS wall page with noscript asking to enable javascript
    const wallPage = `
      <noscript>Please enable JavaScript to view the full article.</noscript>
    `;
    expect(isBrowserRequired(wallPage)).toBe(true);

    // Cloudflare challenge
    const cfPage = `<div>Checking your browser before accessing site...</div>`;
    expect(isBrowserRequired(cfPage)).toBe(true);
  });

  it("evaluateCandidateSamples rethrows BudgetExceededError", async () => {
    const fakeModels = {
      judge: vi
        .fn()
        .mockRejectedValue(
          new BudgetExceededError("gateway", "2026-10-24", 50000),
        ),
    };

    await expect(
      evaluateCandidateSamples(
        [
          {
            url: "https://foo.com/1",
            title: "Sample 1",
            body: "Lorem ipsum dolor sit amet article content...",
          },
        ],
        "Biotech",
        SAMPLE_ANALYSIS_CONFIG as unknown as AnalysisConfig,
        { models: fakeModels as unknown as ModelClient },
      ),
    ).rejects.toThrow(BudgetExceededError);
  });

  it("consumer handles discover message properly", async () => {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug: "consumer-ind",
        name: "Consumer Section",
        publishMode: "review",
        createdAt: 1000,
      })
      .returning({ id: industries.id });

    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        createdAt: 1000,
      })
      .returning({ id: discoveryRuns.id });

    let acked = false;
    const msg: Message<GenerateMessage> = {
      id: "msg-1",
      body: { kind: "discover", runId: run[0].id },
      timestamp: new Date(),
      attempts: 1,
      ack: () => {
        acked = true;
      },
      retry: () => {},
    };

    const batch: MessageBatch<GenerateMessage> = {
      queue: "ainews-generate",
      messages: [msg],
      ackAll: () => {},
      retryAll: () => {},
      metadata: {} as unknown as MessageBatchMetadata,
    };

    // Run via handleGenerateBatch
    await handleGenerateBatch(
      batch,
      { ...env, DISCOVERY_ENABLED: "false" },
      {},
    );

    expect(acked).toBe(true);
    const runAfter = (
      await db
        .select()
        .from(discoveryRuns)
        .where(eq(discoveryRuns.id, run[0].id))
    )[0];
    expect(runAfter.status).toBe("skipped");
  });

  it("preserves admin rejected status when re-discovered and does not auto-enable", async () => {
    const db = drizzle(env.DB);
    const ind = await db
      .insert(industries)
      .values({
        slug: "preserve-ind",
        name: "Preserve Section",
        publishMode: "review",
        config: JSON.stringify(SAMPLE_ANALYSIS_CONFIG),
        createdAt: 1000,
      })
      .returning({ id: industries.id });

    // Existing candidate rejected by admin
    await db.insert(sourceCandidates).values({
      industryId: ind[0].id,
      name: "Existing Cand",
      feedUrl: "https://preserve.com/feed.xml",
      siteDomain: "preserve.com",
      kind: "rss",
      fetchRung: 0,
      status: "rejected",
      rejectionReason: "rejected_by_admin",
      createdAt: 1000,
    });

    const run = await db
      .insert(discoveryRuns)
      .values({
        industryId: ind[0].id,
        status: "pending",
        createdAt: 2000,
      })
      .returning({ id: discoveryRuns.id });

    const fakeWebSearch = {
      search: vi.fn().mockResolvedValue({
        items: [{ url: "https://preserve.com" }],
        metadata: { query: "q", requestId: "r", latencyMs: 1 },
      }),
    };

    const rssXml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <title>Preserve Feed</title>
        <link>https://preserve.com</link>
        <item>
          <title>Long enough article 1</title>
          <link>https://preserve.com/art-1</link>
          <description>${"A".repeat(250)}</description>
        </item>
      </channel>
    </rss>`;

    const fakeFetch = vi.fn().mockImplementation(async (urlStr: string) => {
      const u = String(urlStr);
      if (u.includes("robots.txt")) {
        return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      }
      return new Response(rssXml, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      });
    });

    const fakeModels = {
      generateText: vi.fn().mockResolvedValue({ text: '["query"]' }),
      judge: vi.fn().mockResolvedValue({
        relevance: { score: 4, probabilities: { "4": 1 } },
      }),
    };

    await runDiscovery({ ...env, DISCOVERY_ENABLED: "true" }, run[0].id, 2000, {
      webSearch: fakeWebSearch,
      models: fakeModels as unknown as ModelClient,
      fetch: fakeFetch,
    });

    // Check candidate: status should remain rejected and rejectionReason rejected_by_admin
    const cand = (
      await db
        .select()
        .from(sourceCandidates)
        .where(eq(sourceCandidates.feedUrl, "https://preserve.com/feed.xml"))
    )[0];
    expect(cand.status).toBe("rejected");
    expect(cand.rejectionReason).toBe("rejected_by_admin");

    // sources must NOT have this feed activated
    const src = await db
      .select()
      .from(sources)
      .where(eq(sources.feedUrl, "https://preserve.com/feed.xml"));
    expect(src).toHaveLength(0);
  });
});
