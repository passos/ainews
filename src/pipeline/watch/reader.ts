// Reader watches (#132, architecture §6 "读者 watch": 判定 / 清理).
import { utcDay } from "../../providers/budget";
import { findCompleted } from "../../providers/ledger";
import { READER_WATCH_LIMITS } from "../../server/reader-watch/limits";
import type { PipelineEnv } from "../messages";

/**
 * Registers one reader watch judge attempt on `day` (UTC) before the call is
 * sent. Every real send counts once, retries and keys first seen on an
 * earlier day included; only a ledger cache hit (a `completed` row) is
 * exempt and registers nothing. False: the day already has `cap` attempts.
 */
export async function admitReaderJudge(
  db: D1Database,
  logicalKey: string,
  day: string,
  now: number,
  cap: number,
): Promise<boolean> {
  if ((await findCompleted(db, logicalKey)) !== null) return true;
  const res = await db
    .prepare(
      `INSERT INTO reader_watch_admissions (logical_key, day, created_at)
       SELECT ?1, ?2, ?3
       WHERE (SELECT count(*) FROM reader_watch_admissions WHERE day = ?2) < ?4`,
    )
    .bind(logicalKey, day, now, cap)
    .run();
  return res.meta.changes === 1;
}

/**
 * Each cron run, whatever the switch: disables reader watches that nobody
 * subscribed to within 3 days or read for 30 days, and deletes admission
 * rows older than 7 days. Never touches admin watches.
 */
export async function sweepReaderWatches(
  env: Pick<PipelineEnv, "DB">,
  now: number,
): Promise<{ disabled: number; purged: number }> {
  const db = env.DB;
  const [disabled, purged] = await db.batch([
    db
      .prepare(
        `UPDATE watches
         SET status = 'paused', disabled_at = ?1, updated_at = ?1
         WHERE owner_kind = 'reader' AND status = 'active'
           AND ((last_read_at IS NULL AND created_at <= ?2)
                OR last_read_at <= ?3)`,
      )
      .bind(
        now,
        now - READER_WATCH_LIMITS.neverReadMs,
        now - READER_WATCH_LIMITS.unreadMs,
      ),
    db
      .prepare(`DELETE FROM reader_watch_admissions WHERE day < ?1`)
      .bind(utcDay(now - READER_WATCH_LIMITS.admissionKeepDays * 86_400_000)),
  ]);
  return { disabled: disabled.meta.changes, purged: purged.meta.changes };
}
