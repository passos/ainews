// Public write entries: create and revoke a reader watch (architecture §3
// "公开写入口", §6 "读者 watch"). No model calls. Never logs input, IP,
// token, hashes or the feed URL.
import { networkHash, networkKey } from "../../lib/network-key";
import { FINANCE_SLUG } from "../../lib/sections";
import { ReaderWatchError } from "./errors";
import type { ReaderWatchInput } from "./input";
import { READER_WATCH_LIMITS } from "./limits";
import {
  newReaderSlug,
  newReaderToken,
  READER_TOKEN_RE,
  tokenHash,
} from "./token";

export { ReaderWatchError } from "./errors";

export interface CreateContext {
  method: string;
  ip: string | null;
  salt: string | undefined;
  enabled: boolean;
  now: number;
  siteUrl: string;
}

// One statement: the limit checks and the insert are atomic in D1.
const INSERT_READER_WATCH = `INSERT INTO watches
  (slug, question, criteria, keywords, industry_id, status, owner_kind,
   token_hash, creator_hash, created_at, updated_at)
  SELECT ?1, ?2, ?3, ?4, ?5, 'active', 'reader', ?6, ?7, ?8, ?8
  WHERE (SELECT count(*) FROM watches WHERE creator_hash = ?7) < ?9
    AND (SELECT count(*) FROM watches
         WHERE owner_kind = 'reader' AND status = 'active') < ?10`;

async function sectionId(
  db: D1Database,
  slug: string | null,
): Promise<number | null> {
  if (slug === null) return null;
  const row = await db
    .prepare("SELECT id, slug FROM industries WHERE slug = ?1")
    .bind(slug)
    .first<{ id: number; slug: string }>();
  if (!row) throw new ReaderWatchError("unknown_section", 400);
  if (row.slug.trim().toLowerCase() === FINANCE_SLUG) {
    throw new ReaderWatchError("section_not_allowed", 400);
  }
  return row.id;
}

export async function createReaderWatchCore(
  db: D1Database,
  input: ReaderWatchInput,
  ctx: CreateContext,
): Promise<{ feedUrl: string }> {
  if (ctx.method !== "POST") {
    throw new ReaderWatchError("method_not_allowed", 405);
  }
  if (!ctx.enabled) throw new ReaderWatchError("reader_watch_disabled", 403);
  if (!ctx.salt) throw new ReaderWatchError("unavailable", 503);
  const key = networkKey(ctx.ip ?? "");
  if (key === null) throw new ReaderWatchError("no_client_ip", 403);
  const industryId = await sectionId(db, input.industrySlug);

  // Same as utcDay (providers/budget.ts), which public code cannot import.
  const day = new Date(ctx.now).toISOString().slice(0, 10);
  const creatorHash = await networkHash(ctx.salt, "reader_watch", day, key);
  const token = newReaderToken();
  const result = await db
    .prepare(INSERT_READER_WATCH)
    .bind(
      newReaderSlug(),
      input.question,
      input.criteria,
      JSON.stringify(input.keywords),
      industryId,
      await tokenHash(token),
      creatorHash,
      ctx.now,
      READER_WATCH_LIMITS.perNetworkPerDay,
      READER_WATCH_LIMITS.maxActive,
    )
    .run();

  if (result.meta.changes !== 1) {
    const row = await db
      .prepare("SELECT count(*) AS n FROM watches WHERE creator_hash = ?1")
      .bind(creatorHash)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= READER_WATCH_LIMITS.perNetworkPerDay) {
      throw new ReaderWatchError("per_network_limit", 429);
    }
    throw new ReaderWatchError("capacity_full", 503);
  }
  return {
    feedUrl: `${ctx.siteUrl.replace(/\/+$/, "")}/rss/p/${token}.xml`,
  };
}

export async function revokeReaderWatchCore(
  db: D1Database,
  input: { token: string },
  ctx: { method: string; now: number },
): Promise<void> {
  if (ctx.method !== "POST") {
    throw new ReaderWatchError("method_not_allowed", 405);
  }
  if (!READER_TOKEN_RE.test(input.token)) {
    throw new ReaderWatchError("not_found", 404);
  }
  const result = await db
    .prepare(
      `UPDATE watches
       SET status = 'paused', disabled_at = COALESCE(disabled_at, ?2),
           updated_at = ?2
       WHERE token_hash = ?1 AND owner_kind = 'reader'`,
    )
    .bind(await tokenHash(input.token), ctx.now)
    .run();
  if (result.meta.changes === 0) throw new ReaderWatchError("not_found", 404);
}
