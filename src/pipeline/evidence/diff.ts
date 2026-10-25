import type { RevisionDiff } from "../../lib/artifacts/types";

interface ArticleRow {
  title: string;
  source_name: string;
}

interface ClaimRow {
  claim_text: string;
  reality_check: string;
}

/**
 * Computes deterministic differences between event revisions (N§2.2, N§2.5).
 */
export async function computeRevisionDiff(
  db: D1Database,
  eventId: number,
  revision: number,
): Promise<RevisionDiff | null> {
  if (revision <= 1) {
    const { results: articles } = await db
      .prepare(
        `SELECT a.title, s.name AS source_name
         FROM event_articles ea
         JOIN articles a ON a.id = ea.article_id
         JOIN sources s ON s.id = a.source_id
         JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
         WHERE ea.event_id = ?1 AND ea.input_revision <= 1
         ORDER BY a.id ASC`,
      )
      .bind(eventId)
      .all<ArticleRow>();

    const { results: claims } = await db
      .prepare(
        `SELECT claim_text, reality_check
         FROM claims
         WHERE event_id = ?1 AND input_revision <= 1
           AND status = 'published'
           AND claim_text NOT LIKE '[%]'
         ORDER BY id ASC`,
      )
      .bind(eventId)
      .all<ClaimRow>();

    const newSources = [
      ...new Set(
        articles.map((a) => (a.source_name ? a.source_name : a.title)),
      ),
    ];
    const newClaims = [...new Set(claims.map((c) => c.claim_text))];

    return {
      revision: 1,
      summary:
        newSources.length > 0
          ? `Initial report based on ${newSources.join(", ")}.`
          : "Initial reporting on the event.",
      newSources,
      newClaims,
      changedClaims: [],
    };
  }

  // Revision > 1: compare revision vs revision - 1
  const { results: newArticles } = await db
    .prepare(
      `SELECT a.title, s.name AS source_name
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       JOIN sources s ON s.id = a.source_id
       JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
       WHERE ea.event_id = ?1 AND ea.input_revision = ?2
       ORDER BY a.id ASC`,
    )
    .bind(eventId, revision)
    .all<ArticleRow>();

  const newSources = [
    ...new Set(
      newArticles.map((a) => (a.source_name ? a.source_name : a.title)),
    ),
  ];

  const { results: currentClaims } = await db
    .prepare(
      `SELECT claim_text, reality_check
       FROM claims
       WHERE event_id = ?1 AND input_revision = ?2
         AND status = 'published'
         AND claim_text NOT LIKE '[%]'
       ORDER BY id ASC`,
    )
    .bind(eventId, revision)
    .all<ClaimRow>();

  const { results: priorClaims } = await db
    .prepare(
      `SELECT claim_text, reality_check
       FROM claims
       WHERE event_id = ?1 AND input_revision = ?2
         AND status = 'published'
         AND claim_text NOT LIKE '[%]'
       ORDER BY id ASC`,
    )
    .bind(eventId, revision - 1)
    .all<ClaimRow>();

  const priorMap = new Map<string, string>();
  for (const c of priorClaims) {
    priorMap.set(c.claim_text, c.reality_check);
  }

  const newClaims: string[] = [];
  const changedClaims: string[] = [];

  for (const c of currentClaims) {
    if (!priorMap.has(c.claim_text)) {
      newClaims.push(c.claim_text);
    } else if (priorMap.get(c.claim_text) !== c.reality_check) {
      changedClaims.push(
        `${c.claim_text} (${priorMap.get(c.claim_text)} → ${c.reality_check})`,
      );
    }
  }

  let summary: string;
  if (newClaims.length > 0 && newSources.length > 0) {
    summary = `New claims identified from ${newSources.join(", ")}: ${newClaims.slice(0, 2).join("; ")}.`;
  } else if (newSources.length > 0) {
    summary = `New sources added: ${newSources.join(", ")}.`;
  } else if (newClaims.length > 0) {
    summary = `New claims identified: ${newClaims.slice(0, 2).join("; ")}.`;
  } else if (changedClaims.length > 0) {
    summary = `Updated reality check status on existing claims.`;
  } else {
    summary = `Event updated at revision ${revision}.`;
  }

  return {
    revision,
    summary,
    newSources,
    newClaims,
    changedClaims,
  };
}

/**
 * Computes and synchronizes the revision_diff artifact in event_artifacts.
 * Idempotent: updates content if claims or sources changed.
 */
export async function syncRevisionDiff(
  db: D1Database,
  eventId: number,
  revision: number,
  initialStatus: "published" | "pending_review",
  now: number,
): Promise<boolean> {
  const diffData = await computeRevisionDiff(db, eventId, revision);
  if (!diffData) return false;

  await db
    .prepare(
      `INSERT INTO event_artifacts (
         event_id, type, audience, input_revision, prompt_version, model, content, status, created_at
       )
       SELECT ?1, 'revision_diff', '', ?2, 'diff-v1', 'deterministic', ?3, ?4, ?5
       WHERE (SELECT revision FROM events WHERE id = ?1) = ?2
       ON CONFLICT (event_id, type, audience, input_revision, prompt_version, model)
       DO UPDATE SET
         content = CASE
           WHEN (
             COALESCE(json_array_length(excluded.content, '$.newClaims'), 0) +
             COALESCE(json_array_length(excluded.content, '$.changedClaims'), 0) +
             COALESCE(json_array_length(excluded.content, '$.newSources'), 0)
           ) >= (
             COALESCE(json_array_length(event_artifacts.content, '$.newClaims'), 0) +
             COALESCE(json_array_length(event_artifacts.content, '$.changedClaims'), 0) +
             COALESCE(json_array_length(event_artifacts.content, '$.newSources'), 0)
           )
           THEN excluded.content
           ELSE event_artifacts.content
         END,
         status = CASE
           WHEN excluded.status = 'published' THEN 'published'
           ELSE event_artifacts.status
         END`,
    )
    .bind(eventId, revision, JSON.stringify(diffData), initialStatus, now)
    .run();

  return true;
}
