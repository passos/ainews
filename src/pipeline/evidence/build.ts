import { isEnabled } from "../../lib/flags";
import { DEFAULT_SLOTS, SETTING_SLOTS } from "../../providers/defaults";
import { createModelClient, type ModelClient } from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import { FINANCE_SLUG } from "../../server/admin/ops";
import type { PipelineEnv } from "../messages";
import { indexArticleChunks, sha256Hex } from "./chunks";
import {
  buildClaimsExtractionRequest,
  CLAIMS_PROMPT_VERSION,
  parseClaimsOutput,
  type ArticleEvidenceInput,
  type EventEvidenceInput,
} from "./prompts";
import {
  evaluateClaimConsensus,
  isPrimarySourceDomain,
  verifyQuoteInBody,
} from "./verify";

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
  source_name: string;
  source_domain: string;
}

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

export async function generateEventEvidence(
  env: PipelineEnv,
  eventId: number,
  commitNow = Date.now(),
  overrides?: Partial<EvidenceDeps>,
): Promise<EvidenceGenerationResult> {
  const deps = defaultEvidenceDeps(env, overrides, commitNow);

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
             COALESCE(NULLIF(s.name, ''), s.site_domain, 'Unknown source') AS source_name,
             s.site_domain AS source_domain
           FROM event_articles ea
           JOIN articles a ON a.id = ea.article_id
           JOIN sources s ON s.id = a.source_id
           JOIN reviews r ON r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
           LEFT JOIN analyses an ON an.id = (
             SELECT id FROM analyses
             WHERE article_id = a.id AND selected = 1
             ORDER BY created_at DESC, id DESC
             LIMIT 1
           )
           WHERE ea.event_id = ?1
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

  const articleRows =
    (articleBatchResult.results as ApprovedArticleRow[] | undefined) ?? [];
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
         AND claim_text IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}')
       LIMIT 1`,
    )
    .bind(eventId, inputRevision)
    .first<{ id: number }>();

  if (existingClaim) {
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
        try {
          await indexArticleChunks(
            { vectors: deps.vectors, models: deps.models },
            a.id,
            a.body_sha,
            bodyText,
          );
        } catch (err) {
          console.warn({
            warning: "failed to index article chunks into V_CHUNKS",
            articleId: a.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    articleInputs.push({
      id: a.id,
      title: a.title,
      sourceName: a.source_name,
      sourceDomain: a.source_domain,
      bodySha: a.body_sha,
      isPrimarySource: isPrimarySourceDomain(a.source_domain, primaryDomains),
      bodyText,
    });
  }

  // If none of the approved articles have readable bodies, skip and allow retry later
  const readableArticles = articleInputs.filter((a) => a.bodyText.length > 0);
  if (readableArticles.length === 0) {
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
  const res = await deps.models.generateText("reason", logicalKey, request);

  if (res.finishReason && res.finishReason !== "STOP") {
    console.warn({
      warning: "reason generation finishReason was not STOP",
      eventId,
      finishReason: res.finishReason,
    });
  }

  // 5. Parse output and verify quotes
  const parsed = parseClaimsOutput(res.text);
  const isFinance = event.industry_slug === FINANCE_SLUG;
  const isAuto = !isFinance && event.industry_publish_mode === "auto";
  const initialStatus = isAuto ? "published" : "pending_review";
  const now = deps.now();

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

  // If output legitimately had 0 verifiable claims, record a sentinel empty row to prevent scheduler loop
  if (parsed.claims.length === 0) {
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
        NO_CLAIMS_SENTINEL,
        inputRevision,
        CLAIMS_PROMPT_VERSION,
        modelName,
        now,
      )
      .run();

    return {
      status: "generated",
      eventId,
      claimsCount: 0,
      citationsCount: 0,
    };
  }

  // Clean up any partial claims from previously aborted attempts on this revision
  // First delete child citations in claim_evidence to satisfy foreign key constraints
  await deps.db
    .prepare(
      `DELETE FROM claim_evidence
       WHERE claim_id IN (
         SELECT id FROM claims
         WHERE event_id = ?1
           AND input_revision = ?2
           AND claim_text NOT IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}')
       )`,
    )
    .bind(eventId, inputRevision)
    .run();

  await deps.db
    .prepare(
      `DELETE FROM claims
       WHERE event_id = ?1
         AND input_revision = ?2
         AND claim_text NOT IN ('${NO_CLAIMS_SENTINEL}', '${EVIDENCE_COMPLETE_SENTINEL}')`,
    )
    .bind(eventId, inputRevision)
    .run();

  let totalClaims = 0;
  let totalCitations = 0;

  // 6. Process and persist verified claims & evidence
  for (const rawClaim of parsed.claims) {
    const verifiedCitations: Array<{
      articleId: number;
      bodySha: string;
      quote: string;
      quoteClean: string;
      startOffset: number;
      endOffset: number;
      stance: "support" | "dispute";
      isPrimarySource: boolean;
      verified: boolean;
    }> = [];

    for (const cit of rawClaim.citations) {
      const articleRow = articleRows.find((a) => a.id === cit.articleId);
      if (!articleRow) {
        // Discard hallucinated article IDs not in input snapshot
        continue;
      }

      const bodyText = articleBodiesMap.get(cit.articleId) ?? "";
      const verification = verifyQuoteInBody(bodyText, cit.quote);
      const isPrimary = isPrimarySourceDomain(
        articleRow.source_domain,
        primaryDomains,
      );

      verifiedCitations.push({
        articleId: cit.articleId,
        bodySha: articleRow.body_sha,
        quote: cit.quote,
        quoteClean: verification.quoteClean,
        startOffset: verification.startOffset,
        endOffset: verification.endOffset,
        stance: cit.stance,
        isPrimarySource: isPrimary,
        verified: verification.verified,
      });
    }

    const consensusStatus = evaluateClaimConsensus(verifiedCitations);
    const primarySourcePreferred = verifiedCitations.some(
      (c) => c.verified && c.isPrimarySource,
    );

    // Atomic conditional insert: only write if events.revision is still inputRevision
    const claimInsert = await deps.db
      .prepare(
        `INSERT INTO claims (
           event_id, claim_text, claim_type, consensus_status, primary_source_preferred, status, input_revision, prompt_version, model, created_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
         WHERE (SELECT revision FROM events WHERE id = ?1) = ?7
         ON CONFLICT (event_id, input_revision, claim_text, prompt_version, model) DO NOTHING
         RETURNING id`,
      )
      .bind(
        eventId,
        rawClaim.claimText,
        rawClaim.claimType,
        consensusStatus,
        primarySourcePreferred ? 1 : 0,
        initialStatus,
        inputRevision,
        CLAIMS_PROMPT_VERSION,
        modelName,
        now,
      )
      .first<{ id: number }>();

    if (!claimInsert || !claimInsert.id) {
      // Either revision changed or conflict
      continue;
    }

    const claimId = claimInsert.id;
    totalClaims++;

    // Insert citations for this claim
    if (verifiedCitations.length > 0) {
      const citationStmts = verifiedCitations.map((c) =>
        deps.db
          .prepare(
            `INSERT INTO claim_evidence (
               claim_id, article_id, body_sha, quote, quote_clean, start_offset, end_offset, stance, is_primary_source, verified, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
          )
          .bind(
            claimId,
            c.articleId,
            c.bodySha,
            c.quote,
            c.quoteClean,
            c.startOffset,
            c.endOffset,
            c.stance,
            c.isPrimarySource ? 1 : 0,
            c.verified ? 1 : 0,
            now,
          ),
      );

      await deps.db.batch(citationStmts);
      totalCitations += verifiedCitations.length;
    }
  }

  // Mark completion of the evidence batch
  if (totalClaims > 0) {
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
        EVIDENCE_COMPLETE_SENTINEL,
        inputRevision,
        CLAIMS_PROMPT_VERSION,
        modelName,
        now,
      )
      .run();
  }

  return {
    status: "generated",
    eventId,
    claimsCount: totalClaims,
    citationsCount: totalCitations,
  };
}
