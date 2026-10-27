// Private RSS of a reader watch (#132 slice 4, architecture §6 "读者 watch").
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepReaderWatches } from "../../src/pipeline/watch/reader";
import { revokeReaderWatchCore } from "../../src/server/reader-watch/create";
import { readerFeedResponse } from "../../src/server/reader-watch/feed";
import { newReaderToken, tokenHash } from "../../src/server/reader-watch/token";
import {
  db,
  resetPublication,
  seedArticle,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

const SITE = "https://news.example/";
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const HOUR_MS = 3_600_000;

let tech: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ technology: tech } = await seedSections());
});

let slugCounter = 0;

async function insertWatch(
  token: string,
  o: {
    ownerKind?: "admin" | "reader";
    question?: string;
    createdAt?: number;
  } = {},
): Promise<number> {
  slugCounter += 1;
  const row = await env.DB.prepare(
    `INSERT INTO watches (slug, question, criteria, keywords, industry_id, status, owner_kind,
       token_hash, created_at, updated_at)
     VALUES (?1, ?2, 'A measured change, not an opinion piece.', '["agent"]', ?3, 'active', ?4, ?5, ?6, ?6)
     RETURNING id`,
  )
    .bind(
      `r-${slugCounter.toString(16).padStart(16, "0")}`,
      o.question ?? "When do agent protocols converge?",
      tech.industryId,
      o.ownerKind ?? "reader",
      await tokenHash(token),
      o.createdAt ?? NOW,
    )
    .first<{ id: number }>();
  return row!.id;
}

/** An event with approved articles; returns the event id and article ids. */
async function seedApprovedEvent(
  title: string,
  articleTitles: string[],
): Promise<{ eventId: number; articleIds: number[] }> {
  const eventId = await seedEvent(tech.industryId, title, 1);
  const articleIds: number[] = [];
  for (const t of articleTitles) {
    const id = await seedArticle({ ...tech, title: t, summary: `About ${t}.` });
    await seedEventArticle(eventId, id, 200);
    await seedReview(id, "approved");
    articleIds.push(id);
  }
  return { eventId, articleIds };
}

async function insertHit(
  watchId: number,
  eventId: number,
  rationale: string,
  status: "delivered" | "published" | "pending_review" = "delivered",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watch_hits (watch_id, event_id, event_revision, hit_at, summary, rationale, status)
     VALUES (?1, ?2, 1, ?3, '', ?4, ?5)`,
  )
    .bind(watchId, eventId, NOW - HOUR_MS, rationale, status)
    .run();
}

const cite = (ids: unknown) => JSON.stringify({ articleIds: ids });

const feed = (token: string, now = NOW) =>
  readerFeedResponse(db(), SITE, token, now);

async function lastReadAt(id: number): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT last_read_at FROM watches WHERE id = ?1",
  )
    .bind(id)
    .first<{ last_read_at: number | null }>();
  return row!.last_read_at;
}

const items = (xml: string) => xml.match(/<item>/g)?.length ?? 0;

describe("private reader RSS (#132)", () => {
  it("serves delivered hits to the token holder", async () => {
    const token = newReaderToken();
    const id = await insertWatch(token, {
      question: "Will R&D agents ship this year?",
    });
    const cited = await seedApprovedEvent("Agent standard event", [
      "Cited agent paper",
      "Uncited side story",
    ]);
    await insertHit(id, cited.eventId, cite([cited.articleIds[0]]));
    const published = await seedApprovedEvent("Published event", [
      "Published-status story",
    ]);
    await insertHit(
      id,
      published.eventId,
      cite(published.articleIds),
      "published",
    );
    const pending = await seedApprovedEvent("Pending event", [
      "Pending-status story",
    ]);
    await insertHit(
      id,
      pending.eventId,
      cite(pending.articleIds),
      "pending_review",
    );

    const res = await feed(token);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("Cited agent paper");
    expect(xml).toContain("About Cited agent paper.");
    expect(xml).toContain("Technology Wire");
    expect(xml).toContain(`/e/${cited.eventId}</link>`);
    expect(xml).not.toContain("Uncited side story");
    expect(xml).not.toContain("Published-status story");
    expect(xml).not.toContain("Pending-status story");
    expect(items(xml)).toBe(1);
    expect(xml).toContain("Your watch: Will R&amp;D agents ship this year?");
    expect(xml).not.toContain("R&D");
    expect(xml).toContain(
      "Private feed. Anyone with this address can read it.",
    );
    expect(xml).toContain(`<guid isPermaLink="false">r${id}-`);
    expect(xml).not.toContain(token);
    expect(xml).not.toContain("/rss/p/");
  });

  it("404 for unknown and malformed tokens, 410 after revoke or sweep", async () => {
    for (const bad of ["", "short", `${"a".repeat(42)}!`, "a".repeat(44)]) {
      expect((await feed(bad)).status).toBe(404);
    }
    expect((await feed(newReaderToken())).status).toBe(404);

    // An admin row with a hand-written token_hash is not a private feed.
    const adminToken = newReaderToken();
    const adminId = await insertWatch(adminToken, { ownerKind: "admin" });
    expect((await feed(adminToken)).status).toBe(404);
    expect(await lastReadAt(adminId)).toBeNull();

    const revoked = newReaderToken();
    await insertWatch(revoked);
    expect((await feed(revoked)).status).toBe(200);
    await revokeReaderWatchCore(
      env.DB,
      { token: revoked },
      { method: "POST", now: NOW },
    );
    expect((await feed(revoked)).status).toBe(410);

    // Never read and older than 3 days: the sweep disables it.
    const swept = newReaderToken();
    await insertWatch(swept, { createdAt: NOW - 4 * 24 * HOUR_MS });
    await sweepReaderWatches({ DB: env.DB }, NOW);
    expect((await feed(swept)).status).toBe(410);
  });

  it("touches last_read_at at most every 6 hours", async () => {
    const token = newReaderToken();
    const id = await insertWatch(token);
    expect(await lastReadAt(id)).toBeNull();

    expect((await feed(token, NOW)).status).toBe(200);
    expect(await lastReadAt(id)).toBe(NOW);

    expect((await feed(token, NOW + 5 * HOUR_MS)).status).toBe(200);
    expect(await lastReadAt(id)).toBe(NOW);

    expect((await feed(token, NOW + 7 * HOUR_MS)).status).toBe(200);
    expect(await lastReadAt(id)).toBe(NOW + 7 * HOUR_MS);
  });

  it("drops a hit whose cited article was retracted", async () => {
    const token = newReaderToken();
    const id = await insertWatch(token);
    const ev = await seedApprovedEvent("Retraction event", [
      "Soon retracted story",
      "Other approved story",
    ]);
    await insertHit(id, ev.eventId, cite([ev.articleIds[0]]));
    expect(await (await feed(token)).text()).toContain("Soon retracted story");

    await seedReview(ev.articleIds[0]!, "rejected");
    const xml = await (await feed(token)).text();
    expect(items(xml)).toBe(0);
    expect(xml).not.toContain("Soon retracted story");
    expect(xml).not.toContain("Other approved story");
  });

  it("drops a hit whose cited-article list is missing, corrupt or empty", async () => {
    const token = newReaderToken();
    const id = await insertWatch(token);
    const bad = ["not json", "{}", '{"articleIds": "3"}', '{"articleIds": []}'];
    for (const [i, rationale] of bad.entries()) {
      const ev = await seedApprovedEvent(`Bad event ${i}`, [`Bad story ${i}`]);
      await insertHit(id, ev.eventId, rationale);
    }
    const good = await seedApprovedEvent("Good event", ["Good story"]);
    await insertHit(id, good.eventId, cite(good.articleIds));

    const res = await feed(token);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("Good story");
    for (const i of bad.keys()) {
      expect(xml).not.toContain(`Bad story ${i}`);
    }
    expect(items(xml)).toBe(1);
  });

  it("sends private, noindex headers", async () => {
    const token = newReaderToken();
    await insertWatch(token);
    const res = await feed(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    for (const t of ["short", newReaderToken()]) {
      const miss = await feed(t);
      expect(miss.status).toBe(404);
      expect(miss.headers.get("Cache-Control")).toBe("private, no-store");
      expect(miss.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(miss.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
  });
});
