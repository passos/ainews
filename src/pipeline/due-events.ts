import { APPROVED_ARTICLE_SQL } from "../server/publication/articles";
import { EVIDENCE_TERMINAL_SQL } from "./evidence/build";
import { sendGenerate, type PipelineEnv } from "./messages";

/**
 * The one due-event check for per-event generate kinds (#92). Per-kind
 * eligibility of artifact types lives only in ARTIFACT_REGISTRY.
 */
export type DueKind = "artifacts" | "evidence" | "watch";

/**
 * Per kind: when the current revision reached a definite outcome, and the
 * column that records the last cron enqueue (the rotation key). The values
 * are constants interpolated into SQL, never input.
 */
const DUE_KINDS: Record<DueKind, { doneSql: string; scheduledColumn: string }> =
  {
    artifacts: {
      doneSql: "e.artifacts_evaluated_revision >= e.revision",
      scheduledColumn: "artifacts_scheduled_at",
    },
    evidence: {
      doneSql: `EXISTS (SELECT 1 FROM claims c WHERE c.event_id = e.id AND c.input_revision = e.revision AND c.claim_text IN (${EVIDENCE_TERMINAL_SQL}))`,
      scheduledColumn: "evidence_scheduled_at",
    },
    watch: {
      doneSql: "e.watch_evaluated_revision >= e.revision",
      scheduledColumn: "watch_scheduled_at",
    },
  };

/**
 * Enqueues up to `limit` events with an approved article whose current
 * revision has no definite outcome for `kind`. No time window. Events enqueued
 * least recently come first, so events that stay due cannot starve the others.
 * The enqueue time is written after the send: a failed send leaves the events
 * at the head of the queue; a failed write only repeats an idempotent send.
 */
export async function enqueueDueEvents(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  kind: DueKind,
  now: number,
  limit: number,
): Promise<number[]> {
  if (!env.Q_GENERATE) {
    return [];
  }
  const { doneSql, scheduledColumn } = DUE_KINDS[kind];

  const { results } = await env.DB.prepare(
    `SELECT e.id
     FROM events e
     WHERE e.revision > 0
       AND NOT (${doneSql})
       AND EXISTS (
         SELECT 1 FROM event_articles ea
         JOIN articles a ON a.id = ea.article_id
         WHERE ea.event_id = e.id AND ${APPROVED_ARTICLE_SQL}
       )
     ORDER BY e.${scheduledColumn} ASC, e.id ASC
     LIMIT ?1`,
  )
    .bind(limit)
    .all<{ id: number }>();

  if (!results || results.length === 0) {
    return [];
  }

  const ids = results.map((r) => r.id);
  await sendGenerate(
    env,
    ids.map((eventId) => ({ kind, eventId })),
  );
  await env.DB.prepare(
    `UPDATE events SET ${scheduledColumn} = ?1
     WHERE id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(now, JSON.stringify(ids))
    .run();

  return ids;
}
