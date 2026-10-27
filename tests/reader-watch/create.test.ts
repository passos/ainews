import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { networkHash, networkKey } from "../../src/lib/network-key";
import {
  createReaderWatchCore,
  ReaderWatchError,
  revokeReaderWatchCore,
} from "../../src/server/reader-watch/create";
import type { ReaderWatchInput } from "../../src/server/reader-watch/input";
import {
  READER_TOKEN_RE,
  tokenHash,
} from "../../src/server/reader-watch/token";
import { resetPublication, seedSections } from "../publication/helpers";

const SALT = "a-test-salt-of-more-than-32-random-bytes";
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const DAY_MS = 86_400_000;
const IP = "192.0.2.10";
const INPUT: ReaderWatchInput = {
  question: "Will agent protocols converge this year?",
  criteria: "A shipped standard adopted by two large vendors.",
  keywords: ["agent", "protocol"],
  industrySlug: null,
};

type Ctx = Parameters<typeof createReaderWatchCore>[2];

const ctx = (o: Partial<Ctx> = {}): Ctx => ({
  method: "POST",
  ip: IP,
  salt: SALT,
  enabled: true,
  now: NOW,
  siteUrl: "https://news.example/",
  ...o,
});

const create = (o: Partial<Ctx> = {}, input: ReaderWatchInput = INPUT) =>
  createReaderWatchCore(env.DB, input, ctx(o));

const tokenOf = (feedUrl: string) =>
  /\/rss\/p\/([^/]+)\.xml$/.exec(feedUrl)![1];

async function rejection(p: Promise<unknown>): Promise<{
  status: number;
  code: string;
}> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ReaderWatchError);
  const err = e as ReaderWatchError;
  return { status: err.status, code: err.code };
}

async function countWatches(): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM watches").first<{
    n: number;
  }>();
  return row!.n;
}

let industries: { technology: number; finance: number };

beforeEach(async () => {
  await resetPublication();
  const s = await seedSections();
  industries = {
    technology: s.technology.industryId,
    finance: s.finance.industryId,
  };
});

describe("createReaderWatchCore (#132)", () => {
  it("rejects a non-POST method", async () => {
    expect(await rejection(create({ method: "GET" }))).toEqual({
      status: 405,
      code: "method_not_allowed",
    });
    expect(await countWatches()).toBe(0);
  });

  it("refuses while READER_WATCH_ENABLED is off", async () => {
    expect(await rejection(create({ enabled: false }))).toEqual({
      status: 403,
      code: "reader_watch_disabled",
    });
    expect(await countWatches()).toBe(0);
  });

  it("refuses without IP_HASH_SALT", async () => {
    for (const salt of [undefined, ""]) {
      expect(await rejection(create({ salt }))).toEqual({
        status: 503,
        code: "unavailable",
      });
    }
    expect(await countWatches()).toBe(0);
  });

  it("refuses without a client IP", async () => {
    for (const ip of [null, "", "not-an-ip"]) {
      expect(await rejection(create({ ip }))).toEqual({
        status: 403,
        code: "no_client_ip",
      });
    }
    expect(await countWatches()).toBe(0);
  });

  it("refuses Finance and unknown sections", async () => {
    expect(
      await rejection(create({}, { ...INPUT, industrySlug: "finance" })),
    ).toEqual({ status: 400, code: "section_not_allowed" });
    expect(
      await rejection(create({}, { ...INPUT, industrySlug: "nope" })),
    ).toEqual({ status: 400, code: "unknown_section" });
    expect(await countWatches()).toBe(0);
    await create({}, { ...INPUT, industrySlug: "technology" });
    const row = await env.DB.prepare("SELECT industry_id FROM watches").first<{
      industry_id: number;
    }>();
    expect(row!.industry_id).toBe(industries.technology);
  });

  it("stores only hashes", async () => {
    const { feedUrl } = await create();
    const token = tokenOf(feedUrl);
    expect(token).toMatch(READER_TOKEN_RE);
    expect(feedUrl).toBe(`https://news.example/rss/p/${token}.xml`);

    const row = await env.DB.prepare("SELECT * FROM watches").first<
      Record<string, unknown>
    >();
    expect(row!.token_hash).toBe(await tokenHash(token));
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const all = JSON.stringify(row);
    expect(all).not.toContain(token);
    expect(all).not.toContain(IP);
    expect(row!.creator_hash).toBe(
      await networkHash(SALT, "reader_watch", "2026-10-26", networkKey(IP)!),
    );
    expect(row!.owner_kind).toBe("reader");
    expect(row!.status).toBe("active");
    expect(row!.question).toBe(INPUT.question);
    expect(row!.criteria).toBe(INPUT.criteria);
    expect(JSON.parse(row!.keywords as string)).toEqual(INPUT.keywords);
    expect(row!.industry_id).toBeNull();
    expect(row!.created_at).toBe(NOW);
    expect(row!.updated_at).toBe(NOW);
    expect(row!.disabled_at).toBeNull();
    expect(row!.last_read_at).toBeNull();
    expect(row!.slug).toMatch(/^r-[0-9a-f]{16}$/);
    expect(row!.slug as string).not.toContain(token);

    const second = tokenOf((await create()).feedUrl);
    expect(second).not.toBe(token);
  });

  it("limits creates per network per UTC day", async () => {
    for (let i = 0; i < 3; i++) await create();
    expect(await rejection(create())).toEqual({
      status: 429,
      code: "per_network_limit",
    });

    // One IPv6 /64 is one network.
    await create({ ip: "2001:db8:a:b::1" });
    await create({ ip: "2001:db8:a:b::1" });
    await create({ ip: "2001:db8:a:b:1::2" });
    expect(await rejection(create({ ip: "2001:db8:a:b:ffff::3" }))).toEqual({
      status: 429,
      code: "per_network_limit",
    });

    // Another network, and the same network on the next UTC day.
    await create({ ip: "198.51.100.7" });
    await create({ now: NOW + DAY_MS });

    // A revoke does not give the slot back.
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      tokens.push(tokenOf((await create({ ip: "203.0.113.5" })).feedUrl));
    }
    await revokeReaderWatchCore(
      env.DB,
      { token: tokens[0] },
      { method: "POST", now: NOW },
    );
    expect(await rejection(create({ ip: "203.0.113.5" }))).toEqual({
      status: 429,
      code: "per_network_limit",
    });
  });

  it("refuses when 200 reader watches are active", async () => {
    const insert = (i: number, owner: string) =>
      env.DB.prepare(
        `INSERT INTO watches (slug, question, criteria, keywords, status, owner_kind, created_at, updated_at)
         VALUES (?1, 'q', 'c', '["k"]', 'active', ?2, 0, 0)`,
      ).bind(`cap-${owner}-${i}`, owner);
    await env.DB.batch([
      ...Array.from({ length: 200 }, (_, i) => insert(i, "reader")),
      ...Array.from({ length: 5 }, (_, i) => insert(i, "admin")),
    ]);
    expect(await rejection(create())).toEqual({
      status: 503,
      code: "capacity_full",
    });

    await env.DB.prepare(
      "UPDATE watches SET status = 'paused' WHERE slug = 'cap-reader-0'",
    ).run();
    // 199 active reader rows and 5 active admin rows: admin rows do not count.
    await create();
    expect(await countWatches()).toBe(206);
  });
});

describe("revokeReaderWatchCore (#132)", () => {
  it("revokes by token", async () => {
    const token = tokenOf((await create()).feedUrl);
    const later = NOW + 1000;
    expect(
      await rejection(
        revokeReaderWatchCore(env.DB, { token }, { method: "GET", now: later }),
      ),
    ).toEqual({ status: 405, code: "method_not_allowed" });

    await revokeReaderWatchCore(
      env.DB,
      { token },
      { method: "POST", now: later },
    );
    const row = await env.DB.prepare(
      "SELECT status, disabled_at, updated_at FROM watches",
    ).first<{ status: string; disabled_at: number; updated_at: number }>();
    expect(row).toEqual({
      status: "paused",
      disabled_at: later,
      updated_at: later,
    });

    // A second revoke keeps the first disabled_at.
    await revokeReaderWatchCore(
      env.DB,
      { token },
      { method: "POST", now: later + 5000 },
    );
    const again = await env.DB.prepare(
      "SELECT disabled_at FROM watches",
    ).first<{ disabled_at: number }>();
    expect(again!.disabled_at).toBe(later);

    const unknown = "A".repeat(43);
    for (const t of [unknown, "short", `${token}x`, ""]) {
      expect(
        await rejection(
          revokeReaderWatchCore(
            env.DB,
            { token: t },
            { method: "POST", now: later },
          ),
        ),
      ).toEqual({ status: 404, code: "not_found" });
    }
  });

  it("does not touch an admin row, even one with a token_hash", async () => {
    const token = "B".repeat(43);
    await env.DB.prepare(
      `INSERT INTO watches (slug, question, criteria, keywords, status, token_hash, created_at, updated_at)
       VALUES ('admin-demo', 'q', 'c', '["k"]', 'active', ?1, 0, 0)`,
    )
      .bind(await tokenHash(token))
      .run();
    expect(
      await rejection(
        revokeReaderWatchCore(env.DB, { token }, { method: "POST", now: NOW }),
      ),
    ).toEqual({ status: 404, code: "not_found" });
    const row = await env.DB.prepare(
      "SELECT status, disabled_at FROM watches",
    ).first();
    expect(row).toEqual({ status: "active", disabled_at: null });
  });
});
