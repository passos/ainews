import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createIndustry,
  listSourceCandidates,
  approveCandidate,
  rejectCandidate,
  deleteSource,
  resumeSource,
  updateSource,
  triggerDiscovery,
} from "../../src/server/admin/ops";
import { adminOr403 } from "../../src/server/admin/access";
import { isEnabled } from "../../src/lib/flags";

const ACCESS_ENV = {
  ADMIN_EMAIL: "admin@example.com",
  ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
};

describe("Admin Discover & Source Operations", () => {
  it("rejects unauthorized calls without Access tokens with 403", async () => {
    const req = new Request(
      "https://news.ioenv.com/_serverFn/draftIndustryConfig",
      {
        method: "POST",
      },
    );
    await expect(adminOr403(req, ACCESS_ENV)).rejects.toSatisfy(
      (err: unknown) => err instanceof Response && err.status === 403,
    );
  });

  it("createIndustry validates config, enforces Finance rules, and saves new section", async () => {
    // 1. Finance section requires review mode
    await expect(
      createIndustry(env.DB, {
        slug: "finance",
        name: "Finance & Markets",
        publishMode: "auto",
        primaryDomains: ["bloomberg.com"],
        config: "{}",
        disclaimer: "Strict disclaimer",
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof Response && err.status === 400,
    );

    // 2. Finance section requires non-empty disclaimer
    await expect(
      createIndustry(env.DB, {
        slug: "finance",
        name: "Finance & Markets",
        publishMode: "review",
        primaryDomains: ["bloomberg.com"],
        config: "{}",
        disclaimer: null,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof Response && err.status === 400,
    );

    // 3. Valid industry creation
    const created = await createIndustry(env.DB, {
      slug: "biotech",
      name: "Biotechnology",
      publishMode: "review",
      primaryDomains: ["nature.com", "biorxiv.org"],
      config: JSON.stringify({ analysis: { test: true } }),
      disclaimer: null,
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.slug).toBe("biotech");
    expect(created.configVersion).toBe(1);

    // 4. Duplicate slug rejected
    await expect(
      createIndustry(env.DB, {
        slug: "biotech",
        name: "Biotech Duplicate",
        publishMode: "review",
        primaryDomains: [],
        config: "{}",
        disclaimer: null,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof Response && err.status === 400,
    );
  });

  it("candidate management: list, approve, and reject operations", async () => {
    // Setup industry
    const indRes = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('cand-ind', 'Cand Industry', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = indRes!.id;

    // Insert 2 candidates
    const c1 = await env.DB.prepare(
      `INSERT INTO source_candidates (industry_id, name, feed_url, site_domain, kind, fetch_rung, avg_score, status, created_at)
       VALUES (?1, 'Candidate One', 'https://c1.com/feed', 'c1.com', 'rss', 0, 85, 'pending', 1000) RETURNING id`,
    )
      .bind(indId)
      .first<{ id: number }>();

    const c2 = await env.DB.prepare(
      `INSERT INTO source_candidates (industry_id, name, feed_url, site_domain, kind, fetch_rung, avg_score, status, created_at)
       VALUES (?1, 'Candidate Two', 'https://c2.com/feed', 'c2.com', 'rss', 1, 40, 'pending', 1000) RETURNING id`,
    )
      .bind(indId)
      .first<{ id: number }>();

    // 1. List candidates
    const allCands = await listSourceCandidates(env.DB, { industryId: indId });
    expect(allCands.length).toBeGreaterThanOrEqual(2);

    // 2. Approve candidate 1 -> activated in sources
    const approveRes = await approveCandidate(env.DB, c1!.id, 2000);
    expect(approveRes.success).toBe(true);

    const c1Updated = await env.DB.prepare(
      "SELECT status FROM source_candidates WHERE id = ?1",
    )
      .bind(c1!.id)
      .first<{ status: string }>();
    expect(c1Updated?.status).toBe("approved");

    const src1 = await env.DB.prepare(
      "SELECT status, fetch_rung FROM sources WHERE industry_id = ?1 AND feed_url = ?2",
    )
      .bind(indId, "https://c1.com/feed")
      .first<{ status: string; fetch_rung: number }>();
    expect(src1?.status).toBe("active");
    expect(src1?.fetch_rung).toBe(0);

    // 3. Reject candidate 2
    const rejectRes = await rejectCandidate(env.DB, {
      id: c2!.id,
      reason: "low_relevance",
    });
    expect(rejectRes.success).toBe(true);

    const c2Updated = await env.DB.prepare(
      "SELECT status, rejection_reason FROM source_candidates WHERE id = ?1",
    )
      .bind(c2!.id)
      .first<{ status: string; rejection_reason: string }>();
    expect(c2Updated?.status).toBe("rejected");
    expect(c2Updated?.rejection_reason).toBe("low_relevance");

    // 4. Cannot approve candidate requiring browser
    const cBrowser = await env.DB.prepare(
      `INSERT INTO source_candidates (industry_id, name, feed_url, site_domain, kind, fetch_rung, requires_browser, avg_score, status, created_at)
       VALUES (?1, 'Browser Candidate', 'https://browser.com/feed', 'browser.com', 'rss', 0, 1, 90, 'rejected', 1000) RETURNING id`,
    )
      .bind(indId)
      .first<{ id: number }>();

    await expect(
      approveCandidate(env.DB, cBrowser!.id, 2000),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof Response && err.status === 400,
    );

    // 5. Cannot approve non-RSS candidate without list configuration
    const cHtml = await env.DB.prepare(
      `INSERT INTO source_candidates (industry_id, name, feed_url, site_domain, kind, fetch_rung, requires_browser, avg_score, status, created_at)
       VALUES (?1, 'HTML Candidate', 'https://html.com/articles', 'html.com', 'html', 0, 0, 90, 'pending', 1000) RETURNING id`,
    )
      .bind(indId)
      .first<{ id: number }>();

    await expect(approveCandidate(env.DB, cHtml!.id, 2000)).rejects.toSatisfy(
      (err: unknown) => err instanceof Response && err.status === 400,
    );
  });

  it("refuses to resume a system placeholder source", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('resume-ind', 'Resume Industry', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    // Same row the primary tracker creates lazily for a section.
    const placeholder = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at)
       VALUES (?1, 'Primary documents (system)', 'system:primary-documents', 'html', 'paused', 1000)
       RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    const otherSystem = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at)
       VALUES (?1, 'Other system row', 'system:other', 'html', 'paused', 1000)
       RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    const normal = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, paused_reason, fail_count, created_at)
       VALUES (?1, 'Normal', 'https://normal.example/feed', 'normal.example', 'rss', 'paused', 'failing', 5, 1000)
       RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();

    const statusOf = async (id: number) =>
      (await env.DB.prepare("SELECT status FROM sources WHERE id = ?1")
        .bind(id)
        .first<{ status: string }>())!.status;

    for (const id of [placeholder!.id, otherSystem!.id]) {
      await expect(resumeSource(env.DB, id)).rejects.toSatisfy(
        (err: unknown) => err instanceof Response && err.status === 400,
      );
      expect(await statusOf(id)).toBe("paused");
    }

    await resumeSource(env.DB, normal!.id);
    expect(await statusOf(normal!.id)).toBe("active");
  });

  it("a system placeholder cannot be edited, deleted, or resumed through an edit", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('guard-ind', 'Guard Industry', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const placeholder = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, kind, status, created_at)
       VALUES (?1, 'Primary documents (system)', 'system:primary-documents', 'html', 'paused', 1000)
       RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    const is400 = (err: unknown) =>
      err instanceof Response && err.status === 400;

    // The bypass: edit to an https feed, resume, edit back.
    await expect(
      updateSource(env.DB, {
        id: placeholder!.id,
        name: "Disguised",
        feedUrl: "https://disguised.example/feed",
      }),
    ).rejects.toSatisfy(is400);
    await expect(resumeSource(env.DB, placeholder!.id)).rejects.toSatisfy(
      is400,
    );
    await expect(deleteSource(env.DB, placeholder!.id)).rejects.toSatisfy(
      is400,
    );

    const row = await env.DB.prepare(
      "SELECT name, feed_url, status FROM sources WHERE id = ?1",
    )
      .bind(placeholder!.id)
      .first();
    expect(row).toEqual({
      name: "Primary documents (system)",
      feed_url: "system:primary-documents",
      status: "paused",
    });
  });

  it("no edit can turn a real source into a system source", async () => {
    const ind = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('guard-ind-2', 'Guard Industry 2', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const normal = await env.DB.prepare(
      `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, created_at)
       VALUES (?1, 'Normal', 'https://normal2.example/feed', 'normal2.example', 'rss', 'active', 1000)
       RETURNING id`,
    )
      .bind(ind!.id)
      .first<{ id: number }>();
    const is400 = (err: unknown) =>
      err instanceof Response && err.status === 400;

    for (const feedUrl of ["system:primary-documents", "SYSTEM:other"]) {
      await expect(
        updateSource(env.DB, { id: normal!.id, name: "Normal", feedUrl }),
      ).rejects.toSatisfy(is400);
    }
    const row = await env.DB.prepare(
      "SELECT feed_url FROM sources WHERE id = ?1",
    )
      .bind(normal!.id)
      .first<{ feed_url: string }>();
    expect(row!.feed_url).toBe("https://normal2.example/feed");

    // A real edit and a real delete still work.
    await updateSource(env.DB, {
      id: normal!.id,
      name: "Renamed",
      feedUrl: "https://normal2.example/rss",
    });
    const edited = await env.DB.prepare(
      "SELECT name, feed_url FROM sources WHERE id = ?1",
    )
      .bind(normal!.id)
      .first();
    expect(edited).toEqual({
      name: "Renamed",
      feed_url: "https://normal2.example/rss",
    });
    await deleteSource(env.DB, normal!.id);
    expect(
      await env.DB.prepare("SELECT 1 FROM sources WHERE id = ?1")
        .bind(normal!.id)
        .first(),
    ).toBeNull();
  });

  it("an unknown source id is refused by update, delete, and resume", async () => {
    const missing = 987654;
    const refused = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(400);
      return (err as Response).text();
    };
    await refused(
      updateSource(env.DB, {
        id: missing,
        name: "x",
        feedUrl: "https://x.example/feed",
      }),
    );
    await refused(deleteSource(env.DB, missing));
    expect(await refused(resumeSource(env.DB, missing))).toBe(
      "Source not found or not resumable",
    );
  });

  it("triggerDiscovery enqueues message, and fails when DISCOVERY_ENABLED is false", async () => {
    const indRes = await env.DB.prepare(
      "INSERT INTO industries (slug, name, publish_mode, created_at) VALUES ('trig-ind', 'Trigger Industry', 'review', 1000) RETURNING id",
    ).first<{ id: number }>();
    const indId = indRes!.id;

    const sentMessages: unknown[] = [];
    const fakeQueue = {
      send: async (msg: unknown) => {
        sentMessages.push(msg);
      },
    };

    const res = await triggerDiscovery(
      env.DB,
      fakeQueue,
      { industryId: indId, queries: ["test query"] },
      1000,
    );

    expect(res.status).toBe("pending");
    expect(res.runId).toBeGreaterThan(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toEqual({ kind: "discover", runId: res.runId });

    // Safety guard verification: when DISCOVERY_ENABLED is not "true", isEnabled returns false
    expect(isEnabled(env, "DISCOVERY_ENABLED")).toBe(false);
    expect(isEnabled({ DISCOVERY_ENABLED: "false" }, "DISCOVERY_ENABLED")).toBe(
      false,
    );
    expect(isEnabled({ DISCOVERY_ENABLED: "true" }, "DISCOVERY_ENABLED")).toBe(
      true,
    );
  });
});
