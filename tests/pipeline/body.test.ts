// Fetch ladder and `body` messages (#6). Every request goes to a fake: the
// site, its robots.txt and r.jina.ai are answered by `web()`; env.AI is a
// fake binding behind the real src/providers/tomarkdown.ts.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../../src/lib/http";
import { processBody, type BodyDeps } from "../../src/pipeline/body/body";
import { MAX_BODY_BYTES, PAGE_ACCEPT } from "../../src/pipeline/body/ladder";
import { feedKey } from "../../src/pipeline/collect/collect";
import type { IngestMessage, PipelineEnv } from "../../src/pipeline/messages";
import { runQueue } from "../../src/pipeline/queue";
import { toMarkdown } from "../../src/providers/tomarkdown";
import { hookBatch, TODAY } from "../providers/fakes";
import {
  count,
  DAY,
  fakeFetch,
  fakeQueue,
  NOW,
  pipelineEnv,
  resetPipeline,
  seedArticle,
  seedIndustry,
  seedSource,
  type FakeQueue,
} from "./helpers";

const SITE = "news.example.com";
const URL1 = `https://${SITE}/a/1`;
const URL2 = `https://${SITE}/a/2`;
/** 400 non-whitespace characters: passes the 200-character check. */
const LONG = "word ".repeat(100);
const ON = { COLLECT_ENABLED: "true" };
const JINA_ON = {
  ...ON,
  MODEL_CALLS_ENABLED: "true",
  THIRD_PARTY_READER_ENABLED: "true",
  JINA_API_KEY: "test-key",
};

interface Web {
  robots?: () => Response;
  page?: (req: Request) => Response;
  jina?: (req: Request) => Response;
}

/** Fake internet: r.jina.ai, /robots.txt, everything else is `page`. */
function web(w: Web = {}) {
  const f = fakeFetch((req) => {
    const url = new URL(req.url);
    if (url.hostname === "r.jina.ai") {
      return w.jina?.(req) ?? new Response("", { status: 500 });
    }
    if (url.pathname === "/robots.txt") {
      return w.robots?.() ?? new Response("", { status: 404 });
    }
    return w.page?.(req) ?? new Response("", { status: 404 });
  });
  const urls = () => f.requests.map((r) => r.url);
  return {
    ...f,
    urls,
    to: (prefix: string) => urls().filter((u) => u.startsWith(prefix)).length,
    jinaCount: () =>
      urls().filter((u) => u.startsWith("https://r.jina.ai/")).length,
  };
}

interface AiCall {
  name: string;
  type: string;
  bytes: Uint8Array;
  options: unknown;
}

/** env.AI stand-in: records each document, answers with `data`. */
function fakeAi(data: string | null = LONG) {
  const calls: AiCall[] = [];
  const ai = {
    async toMarkdown(doc: MarkdownDocument, options?: unknown) {
      calls.push({
        name: doc.name,
        type: doc.blob.type,
        bytes: new Uint8Array(await doc.blob.arrayBuffer()),
        options,
      });
      return data === null
        ? { id: "1", name: doc.name, mimeType: "", format: "error", error: "x" }
        : {
            id: "1",
            name: doc.name,
            mimeType: "",
            format: "markdown",
            tokens: 0,
            data,
          };
    },
  };
  return { calls, ai: ai as unknown as Ai };
}

function deps(w: ReturnType<typeof web>, ai = fakeAi()): BodyDeps {
  return {
    fetch: w.fetch,
    toMarkdown: (bytes, mime, baseUrl) =>
      toMarkdown(ai.ai, bytes, mime, baseUrl),
  };
}

const html = (body: string = `<p>${LONG}</p>`) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });
const markdown = (body: string = LONG) =>
  new Response(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });

/** Minimal PDF bytes; the fake AI does not parse them. */
const PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

let industry: number;
let source: number;
let q: FakeQueue;

async function setup(
  s: {
    siteDomain?: string | null;
    jinaEnabled?: number;
    fetchRung?: number | null;
    config?: unknown;
  } = {},
) {
  source = await seedSource({
    industryId: industry,
    feedUrl: `https://${SITE}/feed`,
    siteDomain: s.siteDomain === undefined ? SITE : s.siteDomain,
    jinaEnabled: s.jinaEnabled ?? 0,
    fetchRung: s.fetchRung ?? null,
    config: s.config,
  });
}

function article(url = URL1, summary: string | null = "The summary.") {
  return seedArticle({
    sourceId: source,
    industryId: industry,
    url,
    stageUpdatedAt: NOW - DAY,
    requeueCount: 2,
    title: "Title",
    summary,
  });
}

async function articleRow(id: number) {
  return env.DB.prepare(
    `SELECT stage, stage_updated_at, requeue_count, body_sha, body_kind,
       fetch_rung, body_truncated, body_fetched_at FROM articles WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      stage: string;
      stage_updated_at: number;
      requeue_count: number;
      body_sha: string | null;
      body_kind: string | null;
      fetch_rung: number | null;
      body_truncated: number;
      body_fetched_at: number | null;
    }>();
}

async function sourceProbe() {
  return env.DB.prepare(
    "SELECT fetch_rung, rung_fail_count FROM sources WHERE id = ?1",
  )
    .bind(source)
    .first<{ fetch_rung: number | null; rung_fail_count: number }>();
}

async function stored(id: number): Promise<string> {
  const sha = (await articleRow(id))!.body_sha!;
  const object = await env.BODIES.get(`bodies/${id}/${sha}.md`);
  return object!.text();
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function e(flags: Parameters<typeof pipelineEnv>[1] = ON): PipelineEnv {
  return pipelineEnv(q, flags);
}

const analyzed = () => q.sent.filter((m) => m.kind === "analyze");

/** R2 with put() counted. */
function countingBodies() {
  const puts: string[] = [];
  const bodies = new Proxy(env.BODIES, {
    get(target, prop) {
      if (prop === "put") {
        return (key: string, ...rest: unknown[]) => {
          puts.push(key);
          return (target.put as (...a: unknown[]) => unknown)(key, ...rest);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { puts, bodies };
}

beforeEach(async () => {
  await resetPipeline();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_calls"),
    env.DB.prepare("DELETE FROM budgets"),
  ]);
  industry = await seedIndustry("ai");
  await env.DB.prepare(
    `UPDATE industries SET primary_domains = '["example.org"]' WHERE id = ?1`,
  )
    .bind(industry)
    .run();
  q = fakeQueue();
});
afterEach(() => vi.restoreAllMocks());

describe("gates: no request unless every gate passes", () => {
  it("COLLECT_ENABLED off: nothing happens", async () => {
    await setup();
    const id = await article();
    const w = web({ page: () => html() });
    expect(await processBody(e({}), id, NOW, deps(w))).toEqual({
      status: "disabled",
    });
    expect(w.requests).toHaveLength(0);
    expect((await articleRow(id))?.stage).toBe("collected");
    expect(q.sent).toHaveLength(0);
  });

  it("robots.txt disallows: no request to the article, summary only, body_ready", async () => {
    await setup();
    const id = await article();
    const w = web({
      robots: () => new Response("User-agent: *\nDisallow: /a/\n"),
      page: () => html(),
    });
    await processBody(e(), id, NOW, deps(w));
    expect(w.to(URL1)).toBe(0);
    expect(w.to(`https://${SITE}/robots.txt`)).toBe(1);
    const row = await articleRow(id);
    expect(row).toMatchObject({
      stage: "body_ready",
      body_kind: "summary",
      fetch_rung: null,
      stage_updated_at: NOW,
      requeue_count: 0,
      body_fetched_at: NOW,
    });
    const body = "# Title\n\nThe summary.";
    expect(row?.body_sha).toBe(await sha256(body));
    expect(await stored(id)).toBe(body);
    expect(analyzed()).toEqual([{ kind: "analyze", articleId: id }]);
  });

  it("robots.txt 503: disallowed, no request to the article", async () => {
    await setup();
    const id = await article();
    const w = web({
      robots: () => new Response("", { status: 503 }),
      page: () => html(),
    });
    await processBody(e(), id, NOW, deps(w));
    expect(w.to(URL1)).toBe(0);
    expect((await articleRow(id))?.body_kind).toBe("summary");
  });

  it("host outside site_domain and primary_domains: no request at all, robots.txt included", async () => {
    await setup();
    const id = await article("https://evil.example.net/a/1");
    const w = web({ page: () => html() });
    const log = vi.spyOn(console, "log");
    await processBody(e(), id, NOW, deps(w));
    expect(w.requests).toHaveLength(0);
    expect(await articleRow(id)).toMatchObject({
      stage: "body_ready",
      body_kind: "summary",
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ body: id, reason: "host_not_allowed" }),
    );
  });

  it("a subdomain of primary_domains is allowed", async () => {
    await setup();
    const id = await article("https://docs.example.org/p");
    const w = web({ page: () => html() });
    await processBody(e(), id, NOW, deps(w));
    expect(w.to("https://docs.example.org/p")).toBe(1);
    expect((await articleRow(id))?.body_kind).toBe("full");
  });

  it("site_domain empty: no request even on a primary domain, reason no_site_domain, body '# {title}'", async () => {
    await setup({ siteDomain: null });
    const id = await article("https://docs.example.org/p", null);
    const w = web({ page: () => html() });
    const log = vi.spyOn(console, "log");
    await processBody(e(), id, NOW, deps(w));
    expect(w.requests).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ body: id, reason: "no_site_domain" }),
    );
    expect(await stored(id)).toBe("# Title");
    expect((await articleRow(id))?.body_sha).toBe(await sha256("# Title"));
  });

  it("caches robots.txt for 24 hours", async () => {
    await setup();
    const a = await article(URL1);
    const b = await article(URL2);
    const c = await article(`https://${SITE}/a/3`);
    const w = web({ page: () => html() });
    await processBody(e(), a, NOW, deps(w));
    await processBody(e(), b, NOW + DAY - 1, deps(w));
    expect(w.to(`https://${SITE}/robots.txt`)).toBe(1);
    await processBody(e(), c, NOW + DAY, deps(w));
    expect(w.to(`https://${SITE}/robots.txt`)).toBe(2);
  });

  it("redirects: each hop is checked against the whitelist and robots.txt", async () => {
    await setup();
    const off = await article(URL1);
    const blocked = await article(URL2);
    const ok = await article(`https://${SITE}/a/3`);
    const w = web({
      robots: () => new Response("User-agent: *\nDisallow: /private\n"),
      page: (req) => {
        const path = new URL(req.url).pathname;
        const to = {
          "/a/1": "https://evil.example.net/x",
          "/a/2": "/private/x",
          "/a/3": "/b/3",
        }[path];
        return to
          ? new Response(null, { status: 301, headers: { Location: to } })
          : html();
      },
    });
    for (const id of [off, blocked, ok]) {
      await processBody(e(), id, NOW, deps(w));
    }
    expect(w.to("https://evil.example.net/")).toBe(0);
    expect(w.to(`https://${SITE}/private`)).toBe(0);
    expect(w.to(`https://${SITE}/b/3`)).toBe(1);
    expect((await articleRow(off))?.body_kind).toBe("summary");
    expect((await articleRow(blocked))?.body_kind).toBe("summary");
    expect((await articleRow(ok))?.body_kind).toBe("full");
  });
});

describe("rung 0: feed material, no request", () => {
  it("summaryIsBody uses the summary", async () => {
    await setup({ config: { summaryIsBody: true } });
    const id = await article(URL1, LONG);
    const w = web();
    await processBody(e(), id, NOW, deps(w));
    expect(w.requests).toHaveLength(0);
    expect(await articleRow(id)).toMatchObject({
      body_kind: "full",
      fetch_rung: 0,
    });
    expect(await stored(id)).toBe(LONG);
  });

  it("feed content:encoded in R2 goes through toMarkdown", async () => {
    await setup();
    const id = await article();
    await env.BODIES.put(await feedKey(URL1), "<p>feed</p>");
    const ai = fakeAi();
    const w = web();
    await processBody(e(), id, NOW, deps(w, ai));
    expect(w.requests).toHaveLength(0);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].type).toBe("text/html");
    expect(new TextDecoder().decode(ai.calls[0].bytes)).toBe("<p>feed</p>");
    expect((await articleRow(id))?.fetch_rung).toBe(0);
  });

  it("a short summary is not a body: falls through to the page", async () => {
    await setup({ config: { summaryIsBody: true } });
    const id = await article(URL1, "short");
    const w = web({ page: () => markdown() });
    await processBody(e(), id, NOW, deps(w));
    expect(w.to(URL1)).toBe(1);
    expect((await articleRow(id))?.fetch_rung).toBe(1);
  });
});

describe("rungs 1 and 2: one request", () => {
  it("application/pdf goes to toMarkdown as doc.pdf: fetch_rung 2", async () => {
    await setup();
    const id = await article();
    const ai = fakeAi();
    const w = web({
      page: () =>
        new Response(PDF, { headers: { "Content-Type": "application/pdf" } }),
    });
    await processBody(e(), id, NOW, deps(w, ai));
    const req = w.requests.find((r) => r.url === URL1)!;
    expect(req.headers.get("Accept")).toBe(PAGE_ACCEPT);
    expect(req.headers.get("User-Agent")).toBe(USER_AGENT);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0].name.endsWith(".pdf")).toBe(true);
    expect(ai.calls[0].type).toBe("application/pdf");
    expect(ai.calls[0].bytes).toEqual(PDF);
    expect(ai.calls[0].options).toEqual({
      conversionOptions: {
        html: { hostname: URL1 },
        pdf: { metadata: false },
      },
    });
    expect(await articleRow(id)).toMatchObject({
      fetch_rung: 2,
      body_kind: "full",
    });
    expect(await stored(id)).toBe(LONG);
  });

  it("text/markdown is used as is: fetch_rung 1, toMarkdown not called", async () => {
    await setup();
    const id = await article();
    const ai = fakeAi();
    const w = web({ page: () => markdown() });
    await processBody(e(), id, NOW, deps(w, ai));
    expect(ai.calls).toHaveLength(0);
    expect((await articleRow(id))?.fetch_rung).toBe(1);
    expect(await stored(id)).toBe(LONG);
  });

  it("a conversion error or another content type fails the rung", async () => {
    await setup();
    const a = await article(URL1);
    const b = await article(URL2);
    const w = web({
      page: (req) =>
        req.url === URL1
          ? html()
          : new Response(LONG, { headers: { "Content-Type": "image/png" } }),
    });
    await processBody(e(), a, NOW, deps(w, fakeAi(null)));
    await processBody(e(), b, NOW, deps(w));
    expect((await articleRow(a))?.body_kind).toBe("summary");
    expect((await articleRow(b))?.body_kind).toBe("summary");
  });

  it("over 2 MB: markdown is cut and marked; a cut PDF fails", async () => {
    await setup();
    const a = await article(URL1);
    const b = await article(URL2);
    const big = "x".repeat(MAX_BODY_BYTES + 1000);
    const ai = fakeAi();
    const w = web({
      page: (req) =>
        req.url === URL1
          ? markdown(big)
          : new Response(new Uint8Array(MAX_BODY_BYTES + 10), {
              headers: { "Content-Type": "application/pdf" },
            }),
    });
    await processBody(e(), a, NOW, deps(w, ai));
    await processBody(e(), b, NOW, deps(w, ai));
    expect(await articleRow(a)).toMatchObject({
      body_kind: "full",
      body_truncated: 1,
    });
    expect((await stored(a)).length).toBe(MAX_BODY_BYTES);
    expect(ai.calls).toHaveLength(0);
    expect((await articleRow(b))?.body_kind).toBe("summary");
  });
});

describe("2 MB cap on the stored markdown", () => {
  it("a conversion longer than 2 MB is cut on a character boundary and marked", async () => {
    await setup();
    const id = await article();
    await env.BODIES.put(await feedKey(URL1), "<p>feed</p>");
    // 3-byte characters: the cut must not split one.
    const big = "\u4e2d".repeat(MAX_BODY_BYTES / 3 + 100);
    const w = web();
    await processBody(e(), id, NOW, deps(w, fakeAi(big)));
    const row = await articleRow(id);
    expect(row).toMatchObject({ fetch_rung: 0, body_truncated: 1 });
    const text = await stored(id);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      MAX_BODY_BYTES,
    );
    expect(text).toBe("\u4e2d".repeat(Math.floor(MAX_BODY_BYTES / 3)));
    expect(row?.body_sha).toBe(await sha256(text));
  });
});

describe("rung 3: Jina Reader", () => {
  const jinaText = `Title: T\n\nURL Source: ${URL1}\n\nMarkdown Content:\n${LONG}`;

  async function jinaCase(
    flags: Parameters<typeof pipelineEnv>[1],
    jina: number,
    cap = 1_000_000,
  ) {
    await setup({ jinaEnabled: jina });
    await env.DB.prepare(
      "INSERT INTO budgets (day, channel, cap_micros) VALUES (?1, 'jina', ?2)",
    )
      .bind(TODAY, cap)
      .run();
    const id = await article();
    const w = web({
      page: () => new Response("", { status: 404 }),
      jina: () =>
        new Response(jinaText, { headers: { "x-usage-tokens": "1000" } }),
    });
    await processBody(e(flags), id, NOW, deps(w));
    return { id, w };
  }

  it.each([
    ["true", 1, 1],
    ["true", 0, 0],
    ["false", 1, 0],
    ["false", 0, 0],
  ] as const)(
    "THIRD_PARTY_READER_ENABLED=%s, jina_enabled=%i: %i Jina requests",
    async (flag, jina, expected) => {
      const { id, w } = await jinaCase(
        { ...JINA_ON, THIRD_PARTY_READER_ENABLED: flag },
        jina,
      );
      expect(w.jinaCount()).toBe(expected);
      expect((await articleRow(id))?.body_kind).toBe(
        expected > 0 ? "full" : "summary",
      );
    },
  );

  it("the request, the parsed body and the ledger row", async () => {
    const { id, w } = await jinaCase(JINA_ON, 1);
    const req = w.requests.find((r) => r.url.startsWith("https://r.jina.ai/"))!;
    expect(req.url).toBe(`https://r.jina.ai/${URL1}`);
    expect(req.headers.get("Authorization")).toBe("Bearer test-key");
    expect(req.headers.get("X-Return-Format")).toBe("markdown");
    expect(req.headers.get("Accept")).toBe("text/plain");
    expect(await articleRow(id)).toMatchObject({ fetch_rung: 3 });
    expect(await stored(id)).toBe(LONG);
    const call = await env.DB.prepare(
      "SELECT logical_key, slot, channel, status, output_tokens, cost_micros, estimated_micros FROM llm_calls",
    ).first();
    expect(call).toEqual({
      logical_key: `jina:${id}:${TODAY}`,
      slot: "read",
      channel: "jina",
      status: "completed",
      output_tokens: 1000,
      // 1,000 tokens x $0.05/1M = 50 micro-USD; reserved 2,000.
      cost_micros: 50,
      estimated_micros: 2000,
    });
  });

  it("budget too small for the reservation: no Jina request", async () => {
    const { id, w } = await jinaCase(JINA_ON, 1, 1999);
    expect(w.jinaCount()).toBe(0);
    expect((await articleRow(id))?.body_kind).toBe("summary");
  });

  it("MODEL_CALLS_ENABLED off or no JINA_API_KEY: no Jina request", async () => {
    const off = await jinaCase({ ...JINA_ON, MODEL_CALLS_ENABLED: "false" }, 1);
    expect(off.w.jinaCount()).toBe(0);
    await resetPipeline();
    industry = await seedIndustry("ai2");
    await env.DB.prepare("DELETE FROM budgets").run();
    const nokey = await jinaCase({ ...JINA_ON, JINA_API_KEY: undefined }, 1);
    expect(nokey.w.jinaCount()).toBe(0);
  });

  it("a Jina error page is a failure", async () => {
    await setup({ jinaEnabled: 1 });
    await env.DB.prepare(
      "INSERT INTO budgets (day, channel, cap_micros) VALUES (?1, 'jina', 1000000)",
    )
      .bind(TODAY)
      .run();
    const id = await article();
    const w = web({
      jina: () =>
        new Response(
          `Title: x\nWarning: Target URL returned error 403: Forbidden\nMarkdown Content:\n${LONG}`,
        ),
    });
    await processBody(e(JINA_ON), id, NOW, deps(w));
    expect(w.jinaCount()).toBe(1);
    expect((await articleRow(id))?.body_kind).toBe("summary");
  });
});

describe("versions and idempotency", () => {
  it("force twice with a changed body: two R2 objects, body_sha is the second", async () => {
    await setup();
    const id = await article();
    let n = 0;
    const w = web({ page: () => markdown(`${LONG} v${++n}`) });
    await processBody(e(), id, NOW, deps(w), { force: true });
    const first = (await articleRow(id))!.body_sha!;
    await processBody(e(), id, NOW + 1000, deps(w), { force: true });
    const second = (await articleRow(id))!.body_sha!;
    expect(second).not.toBe(first);
    const { objects } = await env.BODIES.list({ prefix: `bodies/${id}/` });
    expect(objects.map((o) => o.key).sort()).toEqual(
      [`bodies/${id}/${first}.md`, `bodies/${id}/${second}.md`].sort(),
    );
    expect(
      await (await env.BODIES.get(`bodies/${id}/${first}.md`))!.text(),
    ).toBe(`${LONG} v1`);
    // The second run did not move the stage again.
    expect(analyzed()).toHaveLength(1);
    expect((await articleRow(id))?.stage).toBe("body_ready");
  });

  it("the same body again does not overwrite the stored version", async () => {
    await setup();
    const id = await article();
    const r2 = countingBodies();
    const w = web({ page: () => markdown() });
    const env1 = { ...e(), BODIES: r2.bodies };
    await processBody(env1, id, NOW, deps(w), { force: true });
    await processBody(env1, id, NOW + 1000, deps(w), { force: true });
    expect(r2.puts).toHaveLength(1);
    const sha = (await articleRow(id))!.body_sha!;
    const object = await env.BODIES.head(`bodies/${id}/${sha}.md`);
    expect(object?.customMetadata?.fetchedAt).toBe(String(NOW));
  });

  it("the same body message delivered twice: one R2 put, one analyze", async () => {
    await setup();
    const id = await article();
    const r2 = countingBodies();
    const w = web({ page: () => markdown() });
    const msg: IngestMessage = { kind: "body", articleId: id };
    const acked: number[] = [];
    const batch = {
      queue: "ainews-ingest",
      messages: [msg, msg].map((body, i) => ({
        id: String(i),
        timestamp: new Date(NOW),
        attempts: 1,
        body,
        ack: () => acked.push(i),
        retry: () => {},
      })),
    } as unknown as MessageBatch;
    await runQueue(
      batch,
      { ...e(), BODIES: r2.bodies },
      {} as ExecutionContext,
      deps(w),
    );
    expect(acked).toEqual([0, 1]);
    expect(r2.puts).toHaveLength(1);
    expect(analyzed()).toHaveLength(1);
    expect(w.to(URL1)).toBe(1);
  });

  it("another delivery moving the stage first wins: no analyze, its body stays", async () => {
    await setup();
    const id = await article();
    const db = hookBatch(async (_n, run) => {
      await env.DB.prepare(
        "UPDATE articles SET stage = 'body_ready', body_sha = 'other', stage_updated_at = 1 WHERE id = ?1",
      )
        .bind(id)
        .run();
      return run();
    });
    const w = web({ page: () => markdown() });
    const result = await processBody({ ...e(), DB: db }, id, NOW, deps(w));
    expect(result).toMatchObject({ status: "ok", advanced: false });
    expect(analyzed()).toHaveLength(0);
    expect(await articleRow(id)).toMatchObject({
      body_sha: "other",
      stage_updated_at: 1,
    });
    // The lost run does not count for the probe either.
    expect((await sourceProbe())?.fetch_rung).toBeNull();
  });
});

describe("probe: sources.fetch_rung", () => {
  it("unset: the first rung that works is stored", async () => {
    await setup();
    const id = await article();
    await processBody(e(), id, NOW, deps(web({ page: () => html() })));
    expect(await sourceProbe()).toEqual({ fetch_rung: 2, rung_fail_count: 0 });
  });

  it("three failures in a row at the recorded rung clear it; a success resets the count", async () => {
    await setup({ fetchRung: 2 });
    const fail = web({ page: () => new Response("", { status: 500 }) });
    const ok = web({ page: () => html() });
    await processBody(
      e(),
      await article(`https://${SITE}/f/1`),
      NOW,
      deps(fail),
    );
    await processBody(
      e(),
      await article(`https://${SITE}/f/2`),
      NOW,
      deps(fail),
    );
    expect(await sourceProbe()).toEqual({ fetch_rung: 2, rung_fail_count: 2 });
    await processBody(e(), await article(`https://${SITE}/ok`), NOW, deps(ok));
    expect(await sourceProbe()).toEqual({ fetch_rung: 2, rung_fail_count: 0 });
    for (const n of [3, 4, 5]) {
      await processBody(
        e(),
        await article(`https://${SITE}/f/${n}`),
        NOW,
        deps(fail),
      );
    }
    expect(await sourceProbe()).toEqual({
      fetch_rung: null,
      rung_fail_count: 0,
    });
  });

  it("recorded rung 3: the page is not fetched", async () => {
    await setup({ fetchRung: 3 });
    const id = await article();
    const w = web({ page: () => html() });
    await processBody(e(), id, NOW, deps(w));
    expect(w.to(URL1)).toBe(0);
    expect(await sourceProbe()).toEqual({ fetch_rung: 3, rung_fail_count: 1 });
  });
});

describe("Crawl-delay", () => {
  it("two messages for one host: the second is sent again with delaySeconds 15, no request", async () => {
    await setup();
    const a = await article(URL1);
    const b = await article(URL2);
    const w = web({
      robots: () => new Response("User-agent: *\nCrawl-delay: 15\n"),
      page: () => html(),
    });
    const acked: number[] = [];
    const batch = {
      queue: "ainews-ingest",
      messages: [a, b].map((articleId, i) => ({
        id: String(i),
        timestamp: new Date(NOW),
        attempts: 1,
        body: { kind: "body", articleId },
        ack: () => acked.push(i),
        retry: () => {
          throw new Error("retry() must not be used");
        },
      })),
    } as unknown as MessageBatch;
    await runQueue(batch, e(), {} as ExecutionContext, deps(w));
    expect(acked).toEqual([0, 1]);
    expect(w.to(URL1)).toBe(1);
    expect(w.to(URL2)).toBe(0);
    const i = q.sent.findIndex((m) => m.kind === "body" && m.articleId === b);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(q.sendOptions[i]).toEqual({ delaySeconds: 15 });
    expect((await articleRow(b))?.stage).toBe("collected");
    expect(await count("SELECT count(*) AS n FROM fetch_hosts")).toBe(1);
  });

  it("after the delay the slot is free again", async () => {
    await setup();
    const a = await article(URL1);
    const b = await article(URL2);
    const w = web({
      robots: () => new Response("User-agent: *\nCrawl-delay: 15\n"),
      page: () => html(),
    });
    await processBody(e(), a, NOW, deps(w));
    expect(await processBody(e(), b, NOW + 14_999, deps(w))).toEqual({
      status: "deferred",
      delaySeconds: 15,
    });
    await processBody(e(), b, NOW + 15_000, deps(w));
    expect(w.to(URL2)).toBe(1);
  });
});
