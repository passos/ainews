import type { ModelClient } from "../../providers/models";
import {
  GROUP_JOIN_MIN_CONFIDENCE,
  GROUP_PROMPT_VERSION,
  MAX_CANDIDATES,
  RECENT_EVENT_WINDOW_MS,
} from "./constants";

export interface GroupArticleDeps {
  db: D1Database;
  vectors: Pick<VectorizeIndex, "query" | "upsert">;
  models: ModelClient;
  now: () => number;
}

export type GroupResult =
  | { status: "grouped"; eventId: number; isNew: boolean }
  | { status: "already_grouped"; eventId: number }
  | { status: "skipped"; reason: string };

interface ArticleRow {
  id: number;
  industry_id: number;
  title: string;
  summary: string | null;
  stage: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function groupArticle(
  deps: GroupArticleDeps,
  articleId: number,
): Promise<GroupResult> {
  // 1. Read article row and verify stage
  const article = await deps.db
    .prepare(
      `SELECT a.id, a.industry_id,
              COALESCE(NULLIF(a.title_override, ''), a.title) AS title,
              COALESCE(NULLIF(a.summary_override, ''), an.summary_en, a.summary) AS summary,
              a.stage
       FROM articles a
       LEFT JOIN analyses an ON an.id = (
         SELECT id FROM analyses WHERE article_id = a.id
         ORDER BY created_at DESC, id DESC LIMIT 1
       )
       WHERE a.id = ?1`,
    )
    .bind(articleId)
    .first<ArticleRow>();

  if (!article) {
    return { status: "skipped", reason: "article_not_found" };
  }

  // Check if article is already assigned to an event
  const existingAssigned = await deps.db
    .prepare("SELECT event_id FROM event_articles WHERE article_id = ?1")
    .bind(articleId)
    .first<{ event_id: number }>();

  if (existingAssigned) {
    if (article.stage === "analyzed") {
      await deps.db
        .prepare(
          "UPDATE articles SET stage = 'grouped', stage_updated_at = ?2, requeue_count = 0 WHERE id = ?1 AND stage = 'analyzed'",
        )
        .bind(articleId, deps.now())
        .run();
    }
    return {
      status: "already_grouped",
      eventId: existingAssigned.event_id,
    };
  }

  if (article.stage !== "analyzed") {
    return { status: "skipped", reason: `stage_is_${article.stage}` };
  }

  // 2. Compute embedding
  const embedText = `${article.title}\n${article.summary ?? ""}`.trim();
  const textSha = await sha256Hex(embedText);
  const embedKey = `embed:article:${articleId}:${textSha}`;
  const [vector] = await deps.models.embed(embedKey, [embedText]);
  if (!vector || vector.length === 0) {
    throw new Error(
      `Embedding generation returned no vector for article ${articleId}`,
    );
  }

  // 3. Upsert vector into Vectorize (metadata: industry_id is Number)
  await deps.vectors.upsert([
    {
      id: String(articleId),
      values: vector,
      metadata: { industry_id: article.industry_id },
    },
  ]);

  // 4. Recall candidates from Vectorize
  const searchRes = await deps.vectors.query(vector, {
    topK: 30,
    returnMetadata: "none",
    filter: { industry_id: { $eq: article.industry_id } },
  });

  const recalledArticleIds = searchRes.matches
    .filter((m) => m.id !== String(articleId))
    .map((m) => Number(m.id))
    .filter((id) => !Number.isNaN(id));

  const recalledEventIds: number[] = [];
  if (recalledArticleIds.length > 0) {
    const placeholders = recalledArticleIds.map(() => "?").join(",");
    const { results } = await deps.db
      .prepare(
        `SELECT article_id, event_id FROM event_articles WHERE article_id IN (${placeholders})`,
      )
      .bind(...recalledArticleIds)
      .all<{ article_id: number; event_id: number }>();

    const artToEvent = new Map<number, number>();
    for (const row of results) {
      artToEvent.set(row.article_id, row.event_id);
    }

    const seenEvents = new Set<number>();
    for (const aId of recalledArticleIds) {
      const eId = artToEvent.get(aId);
      if (eId !== undefined && !seenEvents.has(eId)) {
        seenEvents.add(eId);
        recalledEventIds.push(eId);
        if (recalledEventIds.length >= 10) break;
      }
    }
  }

  // 5. Recent events from D1 (within RECENT_EVENT_WINDOW_MS)
  const currentTime = deps.now();
  const recentEvents = await deps.db
    .prepare(
      `SELECT id FROM events
       WHERE industry_id = ?1 AND created_at >= ?2
       ORDER BY created_at DESC LIMIT 10`,
    )
    .bind(article.industry_id, currentTime - RECENT_EVENT_WINDOW_MS)
    .all<{ id: number }>();

  // 6. Union: recent first, then vector-recalled, deduplicated, up to MAX_CANDIDATES
  const candidateEventIds: number[] = [];
  const seenCandidates = new Set<number>();

  for (const r of recentEvents.results) {
    if (!seenCandidates.has(r.id)) {
      seenCandidates.add(r.id);
      candidateEventIds.push(r.id);
      if (candidateEventIds.length >= MAX_CANDIDATES) break;
    }
  }

  for (const eId of recalledEventIds) {
    if (!seenCandidates.has(eId)) {
      seenCandidates.add(eId);
      candidateEventIds.push(eId);
      if (candidateEventIds.length >= MAX_CANDIDATES) break;
    }
  }

  // If no candidate events exist, create new event directly without calling Jev
  let targetEventId: number | null = null;
  if (candidateEventIds.length > 0) {
    // 7. Call Jev choice
    const candPlaceholders = candidateEventIds.map(() => "?").join(",");
    const { results: eventRows } = await deps.db
      .prepare(`SELECT id, title FROM events WHERE id IN (${candPlaceholders})`)
      .bind(...candidateEventIds)
      .all<{ id: number; title: string }>();

    const eventTitleMap = new Map<number, string>();
    for (const ev of eventRows) {
      eventTitleMap.set(ev.id, ev.title);
    }

    const { results: recentArtRows } = await deps.db
      .prepare(
        `SELECT ea.event_id,
                COALESCE(NULLIF(a.title_override, ''), a.title) AS title
         FROM event_articles ea
         JOIN articles a ON a.id = ea.article_id
         WHERE ea.event_id IN (${candPlaceholders})
         ORDER BY ea.created_at DESC`,
      )
      .bind(...candidateEventIds)
      .all<{ event_id: number; title: string }>();

    const recentArtsMap = new Map<number, string[]>();
    for (const r of recentArtRows) {
      const list = recentArtsMap.get(r.event_id) ?? [];
      if (list.length < 2) {
        list.push(r.title);
        recentArtsMap.set(r.event_id, list);
      }
    }

    const criteria: Record<string, string> = {};
    for (const cId of candidateEventIds) {
      const evTitle = eventTitleMap.get(cId) ?? "";
      const recentTitles = recentArtsMap.get(cId) ?? [];
      const snippet =
        recentTitles.length > 0
          ? `${evTitle} | ${recentTitles.join("; ")}`
          : evTitle;
      criteria[`event_${cId}`] = snippet.slice(0, 300);
    }
    criteria.new = "A different event that is not listed";

    // Hash all inputs (article text + criteria) so changes in text or candidates get fresh decisions
    const inputPayload = JSON.stringify({
      text: embedText,
      criteria,
    });
    const inputSha = await sha256Hex(inputPayload);
    const jevKey = `group:${articleId}:${GROUP_PROMPT_VERSION}:${inputSha.slice(0, 16)}`;

    const answers = await deps.models.judge(
      jevKey,
      {
        title: article.title,
        summary: (article.summary ?? "").slice(0, 2000),
      },
      {
        event: {
          type: "choice",
          instructions:
            'Which existing news event does this article report on? Choose "new" if it reports a different event.',
          criteria,
        },
      },
    );

    // 8. Decision evaluation
    const ans = answers.event;
    if (
      ans &&
      ans.choice !== "new" &&
      ans.choice.startsWith("event_") &&
      ans.confidence >= GROUP_JOIN_MIN_CONFIDENCE
    ) {
      const chosenId = Number(ans.choice.slice("event_".length));
      if (candidateEventIds.includes(chosenId)) {
        targetEventId = chosenId;
      }
    }
  }

  // 9. D1 batch update with atomic article snapshot validation
  const commitNow = deps.now();
  if (targetEventId !== null) {
    try {
      const results = await deps.db.batch([
        // Insert into event_articles ONLY if the article still exists in stage 'analyzed'
        // and shares the same industry as the target event.
        deps.db
          .prepare(
            `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
             SELECT ?1, ?2, ?3, (
               SELECT revision + CASE WHEN EXISTS (
                 SELECT 1 FROM reviews r
                 JOIN articles a ON a.id = r.article_id
                 WHERE a.id = ?2 AND r.body_sha = a.body_sha AND r.decision = 'approved'
               ) THEN 1 ELSE 0 END
               FROM events WHERE id = ?1
             )
             WHERE EXISTS (
               SELECT 1 FROM articles a
               JOIN events e ON e.id = ?1
               WHERE a.id = ?2 AND a.industry_id = e.industry_id AND a.stage = 'analyzed' AND a.industry_id = ?4
             )`,
          )
          .bind(targetEventId, articleId, commitNow, article.industry_id),
        deps.db
          .prepare(
            `UPDATE events SET revision = revision + 1, updated_at = ?1
             WHERE id = ?2 AND EXISTS (
               SELECT 1 FROM reviews r
               JOIN articles a ON a.id = r.article_id
               WHERE a.id = ?3 AND r.body_sha = a.body_sha AND r.decision = 'approved'
             )`,
          )
          .bind(commitNow, targetEventId, articleId),
        deps.db
          .prepare(
            `UPDATE articles SET stage = 'grouped', stage_updated_at = ?1, requeue_count = 0
             WHERE id = ?2 AND stage = 'analyzed' AND industry_id = ?3
               AND EXISTS (SELECT 1 FROM event_articles WHERE event_id = ?4 AND article_id = ?2)`,
          )
          .bind(commitNow, articleId, article.industry_id, targetEventId),
      ]);

      if (results[0].meta.changes !== 1) {
        // Did not insert: check if already assigned or article state changed
        const existing = await deps.db
          .prepare("SELECT event_id FROM event_articles WHERE article_id = ?1")
          .bind(articleId)
          .first<{ event_id: number }>();
        if (existing) {
          return { status: "already_grouped", eventId: existing.event_id };
        }
        return { status: "skipped", reason: "article_state_changed" };
      }

      return { status: "grouped", eventId: targetEventId, isNew: false };
    } catch (e) {
      const existing = await deps.db
        .prepare("SELECT event_id FROM event_articles WHERE article_id = ?1")
        .bind(articleId)
        .first<{ event_id: number }>();
      if (existing) {
        await deps.db
          .prepare(
            "UPDATE articles SET stage = 'grouped', stage_updated_at = ?1, requeue_count = 0 WHERE id = ?2 AND stage = 'analyzed'",
          )
          .bind(commitNow, articleId)
          .run();
        return { status: "already_grouped", eventId: existing.event_id };
      }
      throw e;
    }
  } else {
    try {
      const results = await deps.db.batch([
        // Insert event ONLY if article still exists in stage 'analyzed' with original industry
        deps.db
          .prepare(
            `INSERT INTO events (industry_id, title, created_at, updated_at, revision)
             SELECT a.industry_id, ?2, ?3, ?3, 0
             FROM articles a
             WHERE a.id = ?1 AND a.stage = 'analyzed' AND a.industry_id = ?4`,
          )
          .bind(articleId, article.title, commitNow, article.industry_id),
        deps.db
          .prepare(
            `INSERT INTO event_articles (event_id, article_id, created_at, input_revision)
             SELECT last_insert_rowid(), ?1, ?2, 1
             WHERE changes() = 1`,
          )
          .bind(articleId, commitNow),
        deps.db
          .prepare(
            `UPDATE events SET revision = revision + 1, updated_at = ?1
             WHERE id = (SELECT event_id FROM event_articles WHERE article_id = ?2)
               AND EXISTS (
                 SELECT 1 FROM reviews r
                 JOIN articles a ON a.id = r.article_id
                 WHERE a.id = ?2 AND r.body_sha = a.body_sha AND r.decision = 'approved'
               )`,
          )
          .bind(commitNow, articleId),
        deps.db
          .prepare(
            `UPDATE articles SET stage = 'grouped', stage_updated_at = ?1, requeue_count = 0
             WHERE id = ?2 AND stage = 'analyzed' AND industry_id = ?3
               AND EXISTS (SELECT 1 FROM event_articles WHERE article_id = ?2)`,
          )
          .bind(commitNow, articleId, article.industry_id),
      ]);

      if (results[0].meta.changes !== 1) {
        const existing = await deps.db
          .prepare("SELECT event_id FROM event_articles WHERE article_id = ?1")
          .bind(articleId)
          .first<{ event_id: number }>();
        if (existing) {
          return { status: "already_grouped", eventId: existing.event_id };
        }
        return { status: "skipped", reason: "article_state_changed" };
      }

      const created = await deps.db
        .prepare("SELECT event_id FROM event_articles WHERE article_id = ?1")
        .bind(articleId)
        .first<{ event_id: number }>();
      return { status: "grouped", eventId: created!.event_id, isNew: true };
    } catch (e) {
      const existing = await deps.db
        .prepare("SELECT event_id FROM event_articles WHERE article_id = ?1")
        .bind(articleId)
        .first<{ event_id: number }>();
      if (existing) {
        await deps.db
          .prepare(
            "UPDATE articles SET stage = 'grouped', stage_updated_at = ?1, requeue_count = 0 WHERE id = ?2 AND stage = 'analyzed'",
          )
          .bind(commitNow, articleId)
          .run();
        return { status: "already_grouped", eventId: existing.event_id };
      }
      throw e;
    }
  }
}
