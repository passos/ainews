// #102: evidence/build.ts, evidence/diff.ts and evidence/primary.ts use only
// approved articles. Each event has an approved article, one without a review
// and one approved for an older body version ("stale").
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { generateEventEvidence } from "../../src/pipeline/evidence/build";
import { computeRevisionDiff } from "../../src/pipeline/evidence/diff";
import {
  trackDuePrimarySources,
  trackEventPrimarySources,
  type PrimaryTrackerDeps,
} from "../../src/pipeline/evidence/primary";
import type { PipelineEnv } from "../../src/pipeline/messages";
import type { ModelTransport } from "../../src/providers/transport";
import {
  seedArticleInEvent,
  seedEvent,
  seedSection,
  type SeededArticle,
} from "./approved-behaviour-helpers";

class FakeR2 {
  storage = new Map<string, string>();
  put(key: string, value: string) {
    this.storage.set(key, value);
  }
  async get(key: string) {
    const val = this.storage.get(key);
    return val === undefined ? null : { text: async () => val };
  }
}

describe("evidence/build.ts approved condition (#102)", () => {
  it("builds the prompt from the approved article only", async () => {
    for (const channel of ["gateway", "workers_ai"]) {
      await env.DB.prepare(
        `INSERT INTO budgets (day, channel, cap_micros, spent_micros, reserved_micros)
         VALUES ('2026-10-24', ?1, 10000000, 0, 0)
         ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
      )
        .bind(channel)
        .run();
    }
    const section = await seedSection();
    const eventId = await seedEvent(section.industryId);
    const r2 = new FakeR2();
    const approved = await seedArticleInEvent(eventId, section, {
      kind: "approved",
      title: "Zebra Approved Headline",
    });
    const none = await seedArticleInEvent(eventId, section, {
      kind: "none",
      title: "Quokka Unreviewed Headline",
    });
    const stale = await seedArticleInEvent(eventId, section, {
      kind: "stale",
      title: "Narwhal Stale Headline",
    });
    for (const [a, text] of [
      [approved, "The approved body says something."],
      [none, "The unreviewed body says something."],
      [stale, "The stale body says something."],
    ] as [SeededArticle, string][]) {
      r2.put(`bodies/${a.id}/${a.bodySha}.md`, text);
    }

    const prompts: string[] = [];
    const transport: ModelTransport = {
      run: async (model: string, input: unknown) => {
        if (model === "@cf/baai/bge-m3") {
          return { shape: [1, 3], data: [[0.1, 0.2, 0.3]] };
        }
        prompts.push(JSON.stringify(input));
        return {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "{}" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 100,
            totalTokenCount: 150,
          },
        };
      },
    };

    const testEnv: PipelineEnv = { ...env, MODEL_CALLS_ENABLED: "true" };
    const res = await generateEventEvidence(testEnv, eventId, 1000, {
      transport,
      bodies: r2 as unknown as R2Bucket,
    });

    expect(res).not.toMatchObject({ reason: "no_approved_articles" });
    expect(res).not.toMatchObject({ reason: "missing_article_bodies" });
    const all = prompts.join("\n");
    expect(all).toContain("Zebra Approved Headline");
    expect(all).not.toContain("Quokka Unreviewed Headline");
    expect(all).not.toContain("Narwhal Stale Headline");
  });
});

describe("evidence/diff.ts approved condition (#102)", () => {
  async function seedThree(inputRevision: number) {
    const section = await seedSection();
    const eventId = await seedEvent(section.industryId, {
      revision: inputRevision,
    });
    for (const [kind, name] of [
      ["approved", "Zebra Wire"],
      ["none", "Quokka Wire"],
      ["stale", "Narwhal Wire"],
    ] as const) {
      await seedArticleInEvent(eventId, section, {
        kind,
        title: `${name} title`,
        sourceName: name,
        inputRevision,
      });
    }
    return eventId;
  }

  it("revision 1: newSources lists the approved article's source only", async () => {
    const eventId = await seedThree(1);
    const diff = await computeRevisionDiff(env.DB, eventId, 1);
    expect(diff?.newSources).toEqual(["Zebra Wire"]);
  });

  it("revision 2: newSources lists the approved article's source only", async () => {
    const eventId = await seedThree(2);
    const diff = await computeRevisionDiff(env.DB, eventId, 2);
    expect(diff?.newSources).toEqual(["Zebra Wire"]);
  });
});

describe("evidence/primary.ts approved condition (#102)", () => {
  const LINK = (id: string) => `Read https://arxiv.org/abs/${id} for details.`;

  function notFoundFetch() {
    return vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("robots.txt")) {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
  }

  it("scans bodies of approved articles only for primary links", async () => {
    const section = await seedSection({ primaryDomains: ["arxiv.org"] });
    const eventId = await seedEvent(section.industryId);
    const tag = section.tag.replace(/\D/g, "") || "0";
    const links: Record<string, string> = {};
    for (const [kind, title] of [
      ["approved", "Approved"],
      ["none", "Unreviewed"],
      ["stale", "Stale"],
    ] as const) {
      const a = await seedArticleInEvent(eventId, section, { kind, title });
      links[kind] =
        `${tag}.${kind === "approved" ? "1111" : kind === "none" ? "2222" : "3333"}`;
      await env.BODIES.put(`bodies/${a.id}/${a.bodySha}.md`, LINK(links[kind]));
    }

    const mockFetch = notFoundFetch();
    const deps: PrimaryTrackerDeps = {
      db: env.DB,
      bodies: env.BODIES,
      fetch: mockFetch as unknown as typeof fetch,
      now: () => 2000,
    };
    await trackEventPrimarySources(deps, env, eventId, ["arxiv.org"], 2000);

    const fetched = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(fetched.some((u) => u.includes(links.approved))).toBe(true);
    expect(fetched.some((u) => u.includes(links.none))).toBe(false);
    expect(fetched.some((u) => u.includes(links.stale))).toBe(false);
  });

  it("links an existing article only if it is still approved when the link batch runs", async () => {
    const section = await seedSection({ primaryDomains: ["arxiv.org"] });
    const eventId = await seedEvent(section.industryId);
    const seed = await seedArticleInEvent(eventId, section, {
      kind: "approved",
      title: "Seed",
    });
    const target = await seedArticleInEvent(null, section, {
      kind: "approved",
      title: "Target",
      stage: "analyzed",
      canonicalUrl: "https://arxiv.org/abs/9999.0001",
    });
    await env.BODIES.put(
      `bodies/${seed.id}/${seed.bodySha}.md`,
      LINK("9999.0001"),
    );

    // The approval is revoked between the approval check and the link batch.
    const revokeAfterCheck = new Proxy(env.DB, {
      get(db, prop) {
        if (prop !== "prepare") {
          const v = Reflect.get(db, prop);
          return typeof v === "function" ? v.bind(db) : v;
        }
        return (sql: string) => {
          const stmt = db.prepare(sql);
          if (!sql.trimStart().startsWith("SELECT 1 FROM articles a")) {
            return stmt;
          }
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                first: async () => {
                  const row = await bound.first();
                  await db
                    .prepare("DELETE FROM reviews WHERE article_id = ?1")
                    .bind(target.id)
                    .run();
                  return row;
                },
              };
            },
          };
        };
      },
    });

    const deps: PrimaryTrackerDeps = {
      db: revokeAfterCheck as unknown as D1Database,
      bodies: env.BODIES,
      fetch: notFoundFetch() as unknown as typeof fetch,
      now: () => 2000,
    };
    const res = await trackEventPrimarySources(
      deps,
      env,
      eventId,
      ["arxiv.org"],
      2000,
    );

    expect(res.trackedCount).toBe(0);
    const linked = await env.DB.prepare(
      "SELECT count(*) AS n FROM event_articles WHERE article_id = ?1",
    )
      .bind(target.id)
      .first<{ n: number }>();
    expect(linked?.n).toBe(0);
  });

  it("an unreviewed article is recovered by the tracker, not linked as already approved", async () => {
    // An unreviewed 'grouped' article is not approved, so it takes the
    // recovery path and gets a system review. Treated as approved, it would
    // reach the approved link batch, which refuses it, and get no review.
    const section = await seedSection({ primaryDomains: ["arxiv.org"] });
    const eventId = await seedEvent(section.industryId);
    const seed = await seedArticleInEvent(eventId, section, {
      kind: "approved",
      title: "Seed",
    });
    const target = await seedArticleInEvent(null, section, {
      kind: "none",
      title: "Target",
      stage: "grouped",
      canonicalUrl: "https://arxiv.org/abs/9999.0002",
    });
    await env.BODIES.put(
      `bodies/${seed.id}/${seed.bodySha}.md`,
      LINK("9999.0002"),
    );

    const deps: PrimaryTrackerDeps = {
      db: env.DB,
      bodies: env.BODIES,
      fetch: notFoundFetch() as unknown as typeof fetch,
      now: () => 2000,
    };
    const res = await trackEventPrimarySources(
      deps,
      env,
      eventId,
      ["arxiv.org"],
      2000,
    );

    expect(res.trackedCount).toBe(1);
    const review = await env.DB.prepare(
      "SELECT reviewer FROM reviews WHERE article_id = ?1",
    )
      .bind(target.id)
      .first<{ reviewer: string }>();
    expect(review?.reviewer).toBe("system:primary_tracker");
  });

  it("trackDuePrimarySources scans events with an approved article, not those without", async () => {
    await env.DB.prepare("DELETE FROM event_articles").run();
    await env.DB.prepare("DELETE FROM event_artifacts").run();
    const section = await seedSection({ primaryDomains: ["arxiv.org"] });
    // The unapproved events are newer, so they sort first on a tie.
    const approvedEvent = await seedEvent(section.industryId, {
      updatedAt: 1000,
    });
    const noneEvent = await seedEvent(section.industryId, { updatedAt: 3000 });
    const staleEvent = await seedEvent(section.industryId, { updatedAt: 2000 });
    await seedArticleInEvent(approvedEvent, section, {
      kind: "approved",
      title: "A",
    });
    await seedArticleInEvent(noneEvent, section, { kind: "none", title: "N" });
    await seedArticleInEvent(staleEvent, section, {
      kind: "stale",
      title: "S",
    });
    // The body is missing, so no fetch happens; the scan marker is the trace.
    const dueEnv: PipelineEnv = { ...env, COLLECT_ENABLED: "true" };
    await trackDuePrimarySources(dueEnv, 5000, 1);

    const { results } = await env.DB.prepare(
      "SELECT event_id FROM event_artifacts WHERE type = 'primary_tracked'",
    ).all<{ event_id: number }>();
    expect(results.map((r) => r.event_id)).toEqual([approvedEvent]);
  });
});
