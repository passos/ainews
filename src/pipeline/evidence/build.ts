import { isEnabled } from "../../lib/flags";
import { DEFAULT_SLOTS, SETTING_SLOTS } from "../../providers/defaults";
import { createModelClient, type ModelClient } from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import { FINANCE_SLUG } from "../../server/admin/ops";
import { APPROVED_ARTICLE_SQL } from "../../server/publication/articles";
import type { PipelineEnv } from "../messages";
import { attributeSource } from "../../lib/source-attribution";
import { indexArticleChunks, sha256Hex } from "./chunks";
import {
  buildClaimsExtractionRequest,
  CLAIMS_PROMPT_VERSION,
  MAX_BODY_CHARS_PER_ARTICLE,
  parseClaimsOutput,
  type ArticleEvidenceInput,
  type EventEvidenceInput,
  type RawClaim,
  type RawCitation,
} from "./prompts";
import {
  evaluateClaimConsensus,
  evaluateRealityCheck,
  isPrimarySourceDomain,
  verifyQuoteInBody,
} from "./verify";
import { syncRevisionDiff } from "./diff";

export interface EvidenceDeps {
  db: D1Database;
  bodies?: R2Bucket;
  vectors?: Pick<VectorizeIndex, "upsert">;
  models: ModelClient;
  transport?: ModelTransport;
  now: () => number;
}

export type EvidenceGenerationResult =
  | {
      status: "generated";
      eventId: number;
      claimsCount: number;
      citationsCount: number;
    }
  | {
      status: "skipped";
      eventId: number;
      reason: string;
    };

interface EventRow {
  event_id: number;
  event_title: string;
  event_revision: number;
  industry_id: number;
  industry_slug: string;
  industry_name: string;
  industry_publish_mode: string;
  industry_disclaimer: string | null;
  industry_primary_domains: string;
}

interface ApprovedArticleRow {
  id: number;
  title: string;
  summary: string | null;
  body_sha: string;
  body_truncated: number;
  source_name: string;
  source_domain: string;
}

type ArticleQueryRow = Omit<ApprovedArticleRow, "source_domain"> & {
  source_domain: string | null;
  source_feed_url: string;
  canonical_url: string;
};

export function defaultEvidenceDeps(
  env: PipelineEnv,
  overrides?: Partial<EvidenceDeps>,
  commitNow = Date.now(),
): EvidenceDeps {
  const db = overrides?.db ?? env.DB;
  const bodies = overrides?.bodies ?? env.BODIES;
  const vectors = overrides?.vectors ?? env.V_CHUNKS;
  const transport =
    overrides?.transport ??
    (env.AI
      ? bindingTransport(env.AI, env.AI_GATEWAY_ID ?? "")
      : {
          run: () => Promise.reject(new Error("no AI binding")),
        });
  const now = overrides?.now ?? (() => commitNow);
  const models =
    overrides?.models ??
    createModelClient({
      db,
      transport,
      env,
      now,
    });

  return {
    db,
    bodies,
    vectors,
    models,
    transport,
    now,
  };
}

export const NO_CLAIMS_SENTINEL = "[no_verifiable_claims]";
export const EVIDENCE_COMPLETE_SENTINEL = "[evidence_batch_complete]";
export const EVIDENCE_INCOMPLETE_SENTINEL = "[evidence_incomplete]";

export async function generateEventEvidence(
  env: PipelineEnv,
  eventId: number,
  commitNow = Date.now(),
  overrides?: Partial<EvidenceDeps>,
): Promise<EvidenceGenerationResult> {
  const deps = defaultEvidenceDeps(env, overrides, commitNow);
  const now = deps.now();

  // Invariant: respect MODEL_CALLS_ENABLED safety switch
  if (!isEnabled(env, "MODEL_CALLS_ENABLED")) {
    return { status: "skipped", eventId, reason: "model_calls_disabled" };
  }

  // 1. Atomic input snapshot: query event, approved articles, and settings
  const [eventBatchResult, articleBatchResult, slotBatchResult] =
    await deps.db.batch([
      deps.db
        .prepare(
          `SELECT
             e.id AS event_id,
             e.title AS event_title,
             e.revision AS event_revision,
             i.id AS industry_id,
             i.slug AS industry_slug,
             i.name AS industry_name,
             i.publish_mode AS industry_publish_mode,
             i.disclaimer AS industry_disclaimer,
             i.primary_domains AS industry_primary_domains
           FROM events e
           JOIN industries i ON i.id = e.industry_id
           WHERE e.id = ?1`,
        )
        .bind(eventId),
      deps.db
        .prepare(
          `SELECT
             a.id,
             COALESCE(NULLIF(a.title_override, ''), NULLIF(an.title_en, ''), a.title) AS title,
             COALESCE(NULLIF(a.summary_override, ''), NULLIF(an.summary_en, ''), a.summary) AS summary,
             a.body_sha,
             a.body_truncated,
             COALESCE(NULLIF(s.name, ''), s.site_domain, 'Unknown source') AS source_name,
             s.site_domain AS source_domain,
             s.feed_url AS source_feed_url,
             a.canonical_url
           FROM event_articles ea
           JOIN articles a ON a.id = ea.article_id
           JOIN sources s ON s.id = a.source_id
           LEFT JOIN analyses an ON an.id = (
             SELECT id FROM analyses
             WHERE article_id = a.id AND selected = 1
             ORDER BY created_at DESC, id DESC
             LIMIT 1
           )
           WHERE ea.event_id = ?1 AND ${APPROVED_ARTICLE_SQL}
           ORDER BY a.id ASC`,
        )
        .bind(eventId),
      deps.db
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .bind(SETTING_SLOTS),
    ]);

  const event = (eventBatchResult.results?.[0] as EventRow | undefined) ?? null;
  if (!event) {
    return { status: "skipped", eventId, reason: "event_not_found" };
  }

  const articleRows: ApprovedArticleRow[] = (
    (articleBatchResult.results as ArticleQueryRow[] | undefined) ?? []
  ).map(({ source_feed_url, canonical_url, ...r }) => {
    // A system source's document is judged by its own host (★ Original source).
    const { name, domain } = attributeSource({
      name: r.source_name,
      siteDomain: r.source_domain,
      feedUrl: source_feed_url,
      canonicalUrl: canonical_url,
    });
    return { ...r, source_name: name, source_domain: domain };
  });
  if (articleRows.length === 0) {
    return { status: "skipped", eventId, reason: "no_approved_articles" };
  }

  const inputRevision = event.event_revision;

  // 2. Idempotency check: if claims already exist for this event and revision, skip
  const existingClaim = await deps.db
    .prepare(
      `SELECT id FROM claims
       WHERE event_id = ?1
         AND input_revision = ?2
         AND claim_text IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
       LIMIT 1`,
    )
    .bind(eventId, inputRevision)
    .first<{ id: number }>();

  if (existingClaim) {
    // If claims are already complete, ensure the deterministic revision_diff artifact is up-to-date
    const isFinance = event.industry_slug === FINANCE_SLUG;
    const isAuto = !isFinance && event.industry_publish_mode === "auto";
    const diffStatus = isAuto ? "published" : "pending_review";
    await syncRevisionDiff(deps.db, eventId, inputRevision, diffStatus, now);

    return { status: "skipped", eventId, reason: "already_exists" };
  }

  // Resolve reason slot model name
  let modelName = DEFAULT_SLOTS.reason.model;
  const slotVal = (
    slotBatchResult.results?.[0] as { value?: string } | undefined
  )?.value;
  if (slotVal) {
    try {
      const parsed = JSON.parse(slotVal);
      if (parsed?.reason?.model) {
        modelName = parsed.reason.model;
      }
    } catch {
      // ignore JSON parse error in settings
    }
  }

  // Parse industry primary domains
  let primaryDomains: string[] = [];
  if (event.industry_primary_domains) {
    try {
      primaryDomains = JSON.parse(event.industry_primary_domains);
    } catch {
      primaryDomains = [];
    }
  }

  // 3. Load article bodies from R2 and chunk into Vectorize V_CHUNKS
  const articleInputs: ArticleEvidenceInput[] = [];
  const articleBodiesMap = new Map<number, string>();

  for (const a of articleRows) {
    let bodyText = "";
    if (deps.bodies && a.body_sha) {
      const r2Obj = await deps.bodies.get(`bodies/${a.id}/${a.body_sha}.md`);
      if (r2Obj) {
        bodyText = await r2Obj.text();
      }
    }

    if (!bodyText) {
      console.warn({
        warning: "article body missing in R2 for evidence extraction",
        articleId: a.id,
        bodySha: a.body_sha,
      });
      // Do NOT fall back to summary or title: citations must only verify against actual markdown body
    } else {
      articleBodiesMap.set(a.id, bodyText);

      // Index chunks into V_CHUNKS if bodies and vectorize available
      if (deps.vectors && a.body_sha) {
        await indexArticleChunks(
          { vectors: deps.vectors, models: deps.models },
          a.id,
          a.body_sha,
          bodyText,
        );
      }
    }

    articleInputs.push({
      id: a.id,
      title: a.title,
      sourceName: a.source_name,
      sourceDomain: a.source_domain,
      bodySha: a.body_sha,
      isPrimarySource: isPrimarySourceDomain(a.source_domain, primaryDomains),
      bodyTruncated: a.body_truncated === 1,
      bodyText,
    });
  }

  // If any approved article has a body_sha that could not be read from R2, skip this batch to allow retry
  // when storage consistency or missing bodies recover, rather than producing permanent partial consensus.
  const missingBodies = articleInputs.filter(
    (a) => a.bodySha && a.bodyText.length === 0,
  );
  if (missingBodies.length > 0) {
    console.warn({
      warning:
        "some approved articles have unreadable bodies in R2, skipping generation to allow retry",
      eventId,
      missingArticleIds: missingBodies.map((a) => a.id),
    });
    return { status: "skipped", eventId, reason: "missing_article_bodies" };
  }

  // 4. Build prompt material
  const material: EventEvidenceInput = {
    eventId,
    eventTitle: articleInputs[0]?.title || event.event_title,
    industryName: event.industry_name,
    disclaimer: event.industry_disclaimer,
    articles: articleInputs,
  };

  const hasIncompleteInspection = material.articles.some(
    (a) => a.bodyTruncated || a.bodyText.length > MAX_BODY_CHARS_PER_ARTICLE,
  );

  const inputPayload = JSON.stringify({
    eventId,
    inputRevision,
    promptVersion: CLAIMS_PROMPT_VERSION,
    articles: articleInputs.map((a) => ({
      id: a.id,
      title: a.title,
      bodySha: a.bodySha,
      sourceDomain: a.sourceDomain,
      bodyExcerpt: a.bodyText.slice(0, 500),
    })),
  });
  const inputSha = (await sha256Hex(inputPayload)).slice(0, 16);
  const logicalKey = `evidence:${eventId}:${CLAIMS_PROMPT_VERSION}:${inputRevision}:${inputSha}`;

  const request = buildClaimsExtractionRequest(material);
  let res: { text: string; finishReason?: string };
  try {
    res = await deps.models.generateText(
      "reason",
      logicalKey,
      request,
      (text) => {
        if (!parseClaimsOutput(text)) {
          throw new Error("failed to parse claims output against schema");
        }
      },
    );
  } catch (err) {
    console.warn({
      warning: "failed to generate parseable claims from model",
      eventId,
      logicalKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      status: "skipped",
      eventId,
      reason: "failed_to_parse_model_output",
    };
  }

  if (res.finishReason && res.finishReason !== "STOP") {
    console.warn({
      warning: "reason generation finishReason was not STOP",
      eventId,
      finishReason: res.finishReason,
    });
  }

  // 5. Parse output and verify quotes
  const parsed = parseClaimsOutput(res.text);

  // If output failed to parse, fail as recoverable skipped (do not write sentinel)
  if (!parsed) {
    console.warn({
      warning: "failed to parse claims output against schema",
      eventId,
      finishReason: res.finishReason,
      rawText: res.text.slice(0, 200),
    });
    return {
      status: "skipped",
      eventId,
      reason: "failed_to_parse_model_output",
    };
  }

  // If output legitimately had 0 verifiable claims, record a sentinel row to prevent scheduler loop
  if (parsed.claims.length === 0) {
    const sentinelText = hasIncompleteInspection
      ? EVIDENCE_INCOMPLETE_SENTINEL
      : NO_CLAIMS_SENTINEL;

    await deps.db
      .prepare(
        `INSERT INTO claims (
           event_id, claim_text, claim_type, consensus_status, primary_source_preferred, status, input_revision, prompt_version, model, created_at
         )
         SELECT ?1, ?2, 'fact', 'unverified', 0, 'published', ?3, ?4, ?5, ?6
         WHERE (SELECT revision FROM events WHERE id = ?1) = ?3
         ON CONFLICT (event_id, input_revision, claim_text, prompt_version, model) DO NOTHING`,
      )
      .bind(
        eventId,
        sentinelText,
        inputRevision,
        CLAIMS_PROMPT_VERSION,
        modelName,
        now,
      )
      .run();

    const isFinance = event.industry_slug === FINANCE_SLUG;
    const isAuto = !isFinance && event.industry_publish_mode === "auto";
    const diffStatus = isAuto ? "published" : "pending_review";
    await syncRevisionDiff(deps.db, eventId, inputRevision, diffStatus, now);

    return {
      status: "generated",
      eventId,
      claimsCount: 0,
      citationsCount: 0,
    };
  }

  // Check if a concurrent worker already completed this event revision while we were running the model
  const concurrentCheck = await deps.db
    .prepare(
      `SELECT id FROM claims
       WHERE event_id = ?1
         AND input_revision = ?2
         AND claim_text IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
       LIMIT 1`,
    )
    .bind(eventId, inputRevision)
    .first<{ id: number }>();
  if (concurrentCheck) {
    const isFinance = event.industry_slug === FINANCE_SLUG;
    const isAuto = !isFinance && event.industry_publish_mode === "auto";
    const diffStatus = isAuto ? "published" : "pending_review";
    await syncRevisionDiff(deps.db, eventId, inputRevision, diffStatus, now);

    return { status: "skipped", eventId, reason: "already_exists" };
  }

  // Assemble cleanup, claims, citations, and completion sentinel into a SINGLE atomic D1 batch
  // to eliminate race conditions between separate roundtrips.
  const batchStatements: D1PreparedStatement[] = [];
  const claimIndices: number[] = [];
  const citationIndices: number[] = [];

  // 1. Delete child citations from previously aborted attempts on this revision
  // Admin-reviewed claims (status != 'pending_review') are strictly preserved.
  batchStatements.push(
    deps.db
      .prepare(
        `DELETE FROM claim_evidence
         WHERE claim_id IN (
           SELECT id FROM claims
           WHERE event_id = ?1
             AND input_revision = ?2
             AND status = 'pending_review'
             AND claim_text NOT IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
         )
         AND NOT EXISTS (
           SELECT 1 FROM claims
           WHERE event_id = ?1
             AND input_revision = ?2
             AND claim_text IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
         )`,
      )
      .bind(eventId, inputRevision),
  );

  // 2. Delete parent pending claims from previously aborted attempts on this revision
  batchStatements.push(
    deps.db
      .prepare(
        `DELETE FROM claims
         WHERE event_id = ?1
           AND input_revision = ?2
           AND status = 'pending_review'
           AND claim_text NOT IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
           AND NOT EXISTS (
             SELECT 1 FROM claims
             WHERE event_id = ?1
               AND input_revision = ?2
               AND claim_text IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
           )`,
      )
      .bind(eventId, inputRevision),
  );

  // 3. Deduplicate and merge duplicate claims by normalized claimText so citations from
  // duplicated entries combine before consensus evaluation.
  const mergedClaimsMap = new Map<
    string,
    {
      claimText: string;
      claimType: RawClaim["claimType"];
      citations: RawCitation[];
    }
  >();

  for (const raw of parsed.claims) {
    const key = raw.claimText.trim();
    const existing = mergedClaimsMap.get(key);
    if (!existing) {
      mergedClaimsMap.set(key, {
        claimText: key,
        claimType: raw.claimType,
        citations: [...raw.citations],
      });
    } else {
      for (const cit of raw.citations) {
        if (
          !existing.citations.some(
            (c) =>
              c.articleId === cit.articleId &&
              c.quote === cit.quote &&
              c.stance === cit.stance,
          )
        ) {
          existing.citations.push(cit);
        }
      }
    }
  }

  // 4. Process and assemble verified claims & evidence statements
  for (const rawClaim of mergedClaimsMap.values()) {
    const verifiedCitations: Array<{
      articleId: number;
      bodySha: string;
      quote: string;
      quoteClean: string;
      startOffset: number;
      endOffset: number;
      stance: "support" | "dispute";
      isPrimarySource: boolean;
      sourceRole: "vendor" | "independent";
      verified: boolean;
    }> = [];

    let hasSnapshotDispute = false;

    for (const cit of rawClaim.citations) {
      const articleRow = articleRows.find((a) => a.id === cit.articleId);
      if (!articleRow) {
        // Discard hallucinated article IDs not in input snapshot, but preserve dispute signal
        if (cit.stance === "dispute") {
          hasSnapshotDispute = true;
        }
        continue;
      }

      const bodyText = articleBodiesMap.get(cit.articleId) ?? "";
      const verification = verifyQuoteInBody(bodyText, cit.quote);
      const isPrimary = isPrimarySourceDomain(
        articleRow.source_domain,
        primaryDomains,
      );

      const verifiedQuote =
        verification.verified &&
        verification.startOffset < verification.endOffset
          ? bodyText.slice(verification.startOffset, verification.endOffset)
          : cit.quote;

      verifiedCitations.push({
        articleId: cit.articleId,
        bodySha: articleRow.body_sha,
        quote: verifiedQuote,
        quoteClean: verification.quoteClean,
        startOffset: verification.startOffset,
        endOffset: verification.endOffset,
        stance: cit.stance,
        isPrimarySource: isPrimary,
        sourceRole: cit.sourceRole ?? (isPrimary ? "vendor" : "independent"),
        verified: verification.verified,
      });
    }

    const consensusStatus =
      hasSnapshotDispute || hasIncompleteInspection
        ? "unverified"
        : evaluateClaimConsensus(verifiedCitations);

    const realityCheck = evaluateRealityCheck(verifiedCitations);

    const hasUnresolvedDispute =
      hasSnapshotDispute ||
      hasIncompleteInspection ||
      consensusStatus === "unverified" ||
      verifiedCitations.some((c) => !c.verified && c.stance === "dispute");

    const primarySourcePreferred = verifiedCitations.some(
      (c) => c.verified && c.isPrimarySource,
    );

    // Track index of this claim insert statement in the batch
    claimIndices.push(batchStatements.length);
    batchStatements.push(
      deps.db
        .prepare(
          `INSERT INTO claims (
             event_id, claim_text, claim_type, consensus_status, primary_source_preferred, reality_check, status, input_revision, prompt_version, model, created_at
           )
           SELECT
             e.id,
             ?2,
             ?3,
             ?4,
             ?5,
             ?6,
             CASE
               WHEN i.slug = '${FINANCE_SLUG}' THEN 'pending_review'
               WHEN ?11 = 1 THEN 'pending_review'
               WHEN i.publish_mode = 'auto' AND ?4 != 'unverified' THEN 'published'
               ELSE 'pending_review'
             END,
             ?7,
             ?8,
             ?9,
             ?10
           FROM events e
           JOIN industries i ON i.id = e.industry_id
           WHERE e.id = ?1
             AND e.revision = ?7
             AND NOT EXISTS (
               SELECT 1 FROM claims
               WHERE event_id = ?1
                 AND input_revision = ?7
                 AND claim_text IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
             )
           ON CONFLICT (event_id, input_revision, claim_text, prompt_version, model) DO NOTHING`,
        )
        .bind(
          eventId,
          rawClaim.claimText,
          rawClaim.claimType,
          consensusStatus,
          primarySourcePreferred ? 1 : 0,
          realityCheck,
          inputRevision,
          CLAIMS_PROMPT_VERSION,
          modelName,
          now,
          hasUnresolvedDispute ? 1 : 0,
        ),
    );

    // Insert citation statements linked via claim_text subquery in the same batch
    for (const c of verifiedCitations) {
      citationIndices.push(batchStatements.length);
      batchStatements.push(
        deps.db
          .prepare(
            `INSERT INTO claim_evidence (
               claim_id, article_id, body_sha, quote, quote_clean, start_offset, end_offset, stance, is_primary_source, source_role, verified, created_at
             )
             SELECT
               c.id, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
             FROM claims c
             WHERE c.event_id = ?12
               AND c.input_revision = ?13
               AND c.claim_text = ?14
               AND c.prompt_version = ?15
               AND c.model = ?16
               AND (SELECT revision FROM events WHERE id = ?12) = ?13
               AND NOT EXISTS (
                 SELECT 1 FROM claims
                 WHERE event_id = ?12
                   AND input_revision = ?13
                   AND claim_text IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
               )`,
          )
          .bind(
            c.articleId,
            c.bodySha,
            c.quote,
            c.quoteClean,
            c.startOffset,
            c.endOffset,
            c.stance,
            c.isPrimarySource ? 1 : 0,
            c.sourceRole,
            c.verified ? 1 : 0,
            now,
            eventId,
            inputRevision,
            rawClaim.claimText,
            CLAIMS_PROMPT_VERSION,
            modelName,
          ),
      );
    }
  }

  // 5. Mark completion of the evidence batch
  if (mergedClaimsMap.size > 0) {
    const batchSentinel = hasIncompleteInspection
      ? EVIDENCE_INCOMPLETE_SENTINEL
      : EVIDENCE_COMPLETE_SENTINEL;

    batchStatements.push(
      deps.db
        .prepare(
          `INSERT INTO claims (
             event_id, claim_text, claim_type, consensus_status, primary_source_preferred, status, input_revision, prompt_version, model, created_at
           )
           SELECT ?1, ?2, 'fact', 'unverified', 0, 'published', ?3, ?4, ?5, ?6
           WHERE (SELECT revision FROM events WHERE id = ?1) = ?3
             AND EXISTS (
               SELECT 1 FROM claims
               WHERE event_id = ?1
                 AND input_revision = ?3
                 AND claim_text NOT LIKE '[%]'
             )
             AND NOT EXISTS (
               SELECT 1 FROM claims
               WHERE event_id = ?1
                 AND input_revision = ?3
                 AND claim_text IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}', '${EVIDENCE_INCOMPLETE_SENTINEL}')
             )
           ON CONFLICT (event_id, input_revision, claim_text, prompt_version, model) DO NOTHING`,
        )
        .bind(
          eventId,
          batchSentinel,
          inputRevision,
          CLAIMS_PROMPT_VERSION,
          modelName,
          now,
        ),
    );
  }

  // 5. Execute all statements in a single atomic D1 batch
  const batchResults = await deps.db.batch(batchStatements);
  const totalClaims = claimIndices.reduce(
    (acc, idx) => acc + (batchResults[idx]?.meta.changes ?? 0),
    0,
  );
  const totalCitations = citationIndices.reduce(
    (acc, idx) => acc + (batchResults[idx]?.meta.changes ?? 0),
    0,
  );

  // Sync revision_diff artifact now that claims are committed for this revision
  const isFinance = event.industry_slug === FINANCE_SLUG;
  const isAuto = !isFinance && event.industry_publish_mode === "auto";
  const diffStatus = isAuto ? "published" : "pending_review";
  await syncRevisionDiff(deps.db, eventId, inputRevision, diffStatus, now);

  return {
    status: "generated",
    eventId,
    claimsCount: totalClaims,
    citationsCount: totalCitations,
  };
}
