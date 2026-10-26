import { DEFAULT_SLOTS, SETTING_SLOTS } from "../../providers/defaults";
import { FINANCE_SLUG } from "../../server/admin/ops";
import { parseAnalysisConfig } from "../analyze/config";
import { createModelClient, type ModelClient } from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import type { PipelineEnv } from "../messages";
import {
  ARTIFACT_REGISTRY,
  type ArtifactEligibilityContext,
  type ArticleMetadata,
} from "./registry";
import type {
  ArtifactArticleMaterial,
  ArtifactEventMaterial,
  ArtifactFilingMaterial,
  ArtifactFinancialFactMaterial,
  ArtifactVerifiedClaim,
} from "./prompts";
import {
  compareFinancialMetrics,
  type FactWithMetadata,
} from "../edgar/comparator";
import { syncRevisionDiff } from "../evidence/diff";
import { documentHost, isSystemSource } from "../source-attribution";

export interface ArtifactDeps {
  db?: D1Database;
  bodies?: R2Bucket;
  models?: ModelClient;
  transport?: ModelTransport;
  now?: () => number;
}

export interface ArtifactGenerationResult {
  status: "generated" | "already_up_to_date" | "skipped";
  eventId: number;
  inputRevision?: number;
  generatedCount?: number;
  reason?: string;
}

interface EventRow {
  event_id: number;
  event_title: string;
  event_revision: number;
  industry_id: number;
  industry_slug: string;
  industry_name: string;
  industry_publish_mode: "auto" | "review";
  industry_disclaimer: string | null;
  industry_config: string;
}

interface ApprovedArticleRow {
  id: number;
  title: string;
  summary: string | null;
  body_sha: string;
  published_at: number | null;
  source_name: string;
  source_domain: string | null;
  source_feed_url: string;
  canonical_url: string;
  total_score: number | null;
  content_type: string | null;
  evidence_tags: string | null;
}

/**
 * A placeholder source (no site_domain, or feed_url 'system:…' such as the
 * primary-documents source) names nothing real: use the document's own host
 * as source domain and name.
 */
function attributeSource(
  r: ApprovedArticleRow,
): ApprovedArticleRow & { source_domain: string } {
  if (r.source_domain === null || isSystemSource(r.source_feed_url)) {
    const host = documentHost(r.canonical_url);
    return { ...r, source_domain: host, source_name: host };
  }
  return { ...r, source_domain: r.source_domain };
}

interface ClaimRow {
  id: number;
  claim_text: string;
  claim_type: string;
  consensus_status: string;
  reality_check?: string;
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

function parseDeepThreshold(
  configJson: string,
  selectFallback: number,
): number {
  try {
    const raw = JSON.parse(configJson);
    if (typeof raw?.artifacts?.deepThreshold === "number") {
      return raw.artifacts.deepThreshold;
    }
  } catch {
    // ignore json error
  }
  return selectFallback;
}

function defaultDeps(
  env: PipelineEnv,
  overrides: Partial<ArtifactDeps>,
  nowTime: number,
): Required<ArtifactDeps> {
  const db = overrides.db ?? env.DB;
  const bodies = overrides.bodies ?? env.BODIES;
  const transport =
    overrides.transport ??
    (env.AI
      ? bindingTransport(env.AI, env.AI_GATEWAY_ID ?? "")
      : {
          run: () => Promise.reject(new Error("no AI binding")),
        });
  const now = overrides.now ?? (() => nowTime);
  const models =
    overrides.models ??
    createModelClient({
      db,
      transport,
      env,
      now,
    });

  return { db, bodies, models, transport, now };
}

export async function generateEventArtifacts(
  env: PipelineEnv,
  eventId: number,
  commitNow: number,
  overrides: Partial<ArtifactDeps> = {},
): Promise<ArtifactGenerationResult> {
  const deps = defaultDeps(env, overrides, commitNow);

  // 1. Atomic input snapshot: query event and its approved articles in a single batch
  const [
    eventBatchResult,
    articleBatchResult,
    slotBatchResult,
    claimBatchResult,
  ] = await deps.db.batch([
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
             i.config AS industry_config
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
             a.published_at,
             COALESCE(NULLIF(s.name, ''), s.site_domain, 'Unknown source') AS source_name,
             s.site_domain AS source_domain,
             s.feed_url AS source_feed_url,
             a.canonical_url,
             an.total_score,
             an.content_type,
             an.evidence_tags
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
    deps.db
      .prepare(
        `SELECT id, claim_text, claim_type, consensus_status, reality_check
           FROM claims
           WHERE event_id = ?1
             AND input_revision = (SELECT revision FROM events WHERE id = ?1)
             AND status = 'published'
             AND claim_text NOT LIKE '[%]'
           ORDER BY id ASC`,
      )
      .bind(eventId),
  ]);

  const event = (eventBatchResult.results?.[0] as EventRow | undefined) ?? null;
  if (!event) {
    return { status: "skipped", eventId, reason: "event_not_found" };
  }

  const articleRows = (
    (articleBatchResult.results as ApprovedArticleRow[] | undefined) ?? []
  ).map(attributeSource);
  if (articleRows.length === 0) {
    return { status: "skipped", eventId, reason: "no_approved_articles" };
  }

  const inputRevision = event.event_revision;

  // Resolve write and reason slot model names from settings if configured
  let modelName = DEFAULT_SLOTS.write.model;
  let reasonModelName =
    DEFAULT_SLOTS.reason?.model || "google/gemini-3.8-flash";
  const slotVal = (
    slotBatchResult.results?.[0] as { value?: string } | undefined
  )?.value;
  if (slotVal) {
    try {
      const parsed = JSON.parse(slotVal);
      if (parsed?.write?.model) {
        modelName = parsed.write.model;
      }
      if (parsed?.reason?.model) {
        reasonModelName = parsed.reason.model;
      }
    } catch {
      // ignore JSON parse error in settings
    }
  }

  // 2. Parse thresholds and calculate event score
  const analysisCfg = parseAnalysisConfig(event.industry_config);
  const selectThreshold = analysisCfg?.thresholds.select ?? 50;
  const deepThreshold = parseDeepThreshold(
    event.industry_config,
    selectThreshold,
  );

  const scores = articleRows.map((r) => r.total_score ?? 0);
  const eventScore = scores.length > 0 ? Math.max(...scores) : 0;

  const articleMetas: ArticleMetadata[] = articleRows.map((r) => {
    let parsedTags: string[] = [];
    if (r.evidence_tags) {
      try {
        const raw = JSON.parse(r.evidence_tags);
        if (Array.isArray(raw)) {
          parsedTags = raw.map(String);
        } else if (raw && typeof raw === "object") {
          parsedTags = Object.values(raw).map(String);
        }
      } catch {
        parsedTags = [];
      }
    }
    return {
      id: r.id,
      sourceDomain: r.source_domain,
      contentType: r.content_type,
      evidenceTags: parsedTags,
    };
  });

  const eligibilityCtx: ArtifactEligibilityContext = {
    eventScore,
    selectThreshold,
    deepThreshold,
    articles: articleMetas,
    industrySlug: event.industry_slug,
    industryName: event.industry_name,
  };

  // 3. Fetch body text from R2 (if available) or fallback to summary
  const articleMaterials: ArtifactArticleMaterial[] = await Promise.all(
    articleRows.map(async (r) => {
      let bodyText: string | null = null;
      if (r.body_sha && deps.bodies) {
        try {
          const obj = await deps.bodies.get(`bodies/${r.id}/${r.body_sha}.md`);
          if (obj) {
            bodyText = await obj.text();
          }
        } catch {
          // fallback to summary
        }
      }
      return {
        id: r.id,
        title: r.title,
        sourceName: r.source_name,
        sourceDomain: r.source_domain,
        publishedAt: r.published_at,
        summary: r.summary,
        bodyText: bodyText || r.summary,
      };
    }),
  );

  const verifiedClaims: ArtifactVerifiedClaim[] = (
    (claimBatchResult?.results as ClaimRow[] | undefined) ?? []
  ).map((c) => ({
    id: c.id,
    claimText: c.claim_text,
    claimType: c.claim_type,
    consensusStatus: c.consensus_status,
    realityCheck: c.reality_check,
  }));

  // 3.1 For Finance events, fetch approved filing & associated XBRL financial facts
  let filingMaterial: ArtifactFilingMaterial | undefined;
  let financialFactsList: ArtifactFinancialFactMaterial[] = [];
  let calculatedMetrics:
    import("../../lib/artifacts/types").EarningsMetric[] | undefined;

  if (event.industry_slug === FINANCE_SLUG && articleMaterials.length > 0) {
    const articleIds = articleMaterials.map((a) => a.id);
    const placeholders = articleIds.map(() => "?").join(",");
    const filingRow = await deps.db
      .prepare(
        `SELECT f.*, c.ticker, c.name as company_name, c.cik as company_cik
         FROM filings f
         JOIN companies c ON c.id = f.company_id
         WHERE f.article_id IN (${placeholders})
         ORDER BY f.filing_date DESC LIMIT 1`,
      )
      .bind(...articleIds)
      .first<{
        id: number;
        accession_number: string;
        form: string;
        filing_date: string;
        report_date: string | null;
        sec_url: string;
        fiscal_year: number | null;
        fiscal_period: string | null;
        ticker: string;
        company_name: string;
        company_cik: string;
        company_id: number;
      }>();

    if (filingRow) {
      filingMaterial = {
        id: filingRow.id,
        accessionNumber: filingRow.accession_number,
        form: filingRow.form,
        filingDate: filingRow.filing_date,
        reportDate: filingRow.report_date,
        secUrl: filingRow.sec_url,
        fiscalYear: filingRow.fiscal_year,
        fiscalPeriod: filingRow.fiscal_period,
        companyTicker: filingRow.ticker,
        companyName: filingRow.company_name,
        companyCik: filingRow.company_cik,
      };

      // Query active financial facts for this filing (superseded_by IS NULL)
      const factsRows = await deps.db
        .prepare(
          `SELECT id, taxonomy, concept, unit, val, period_start, period_end, fiscal_year, fiscal_period, sec_url
           FROM financial_facts
           WHERE filing_id = ?1 AND superseded_by IS NULL
           ORDER BY id ASC`,
        )
        .bind(filingRow.id)
        .all<{
          id: number;
          taxonomy: string;
          concept: string;
          unit: string;
          val: string;
          period_start: string | null;
          period_end: string;
          fiscal_year: number | null;
          fiscal_period: string | null;
          sec_url: string;
        }>();

      financialFactsList = (factsRows.results || []).map((f) => ({
        id: f.id,
        taxonomy: f.taxonomy,
        concept: f.concept,
        unit: f.unit,
        val: f.val,
        periodStart: f.period_start,
        periodEnd: f.period_end,
        fiscalYear: f.fiscal_year,
        fiscalPeriod: f.fiscal_period,
        secUrl: f.sec_url,
      }));

      // Query historical approved facts for QoQ and YoY comparisons
      const priorFactsRows = await deps.db
        .prepare(
          `SELECT ff.id, ff.taxonomy, ff.concept, ff.unit, ff.val, ff.period_start, ff.period_end, ff.fiscal_year, ff.fiscal_period, ff.sec_url
           FROM financial_facts ff
           JOIN filings fl ON fl.id = ff.filing_id
           JOIN articles a ON a.id = fl.article_id
           WHERE ff.company_id = ?1
             AND fl.id != ?2
             AND EXISTS (
               SELECT 1 FROM reviews r
               WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved'
             )
           ORDER BY ff.period_end DESC, ff.id DESC`,
        )
        .bind(filingRow.company_id, filingRow.id)
        .all<{
          id: number;
          taxonomy: string;
          concept: string;
          unit: string;
          val: string;
          period_start: string | null;
          period_end: string;
          fiscal_year: number | null;
          fiscal_period: string | null;
          sec_url: string;
        }>();

      const currentFactsForComp: FactWithMetadata[] = financialFactsList.map(
        (f) => ({
          taxonomy: f.taxonomy,
          concept: f.concept,
          label: f.concept,
          unit: f.unit,
          val: f.val,
          periodStart: f.periodStart ?? undefined,
          periodEnd: f.periodEnd,
          fiscalYear: f.fiscalYear ?? undefined,
          fiscalPeriod: f.fiscalPeriod ?? undefined,
          filedDate: filingRow.filing_date,
          accessionNumber: filingRow.accession_number,
          factId: f.id,
          secUrl: f.secUrl,
        }),
      );

      const priorFactsMap = new Map<string, FactWithMetadata>();
      const priorYearFactsMap = new Map<string, FactWithMetadata>();

      const candidateRows = priorFactsRows.results || [];

      for (const cur of currentFactsForComp) {
        const matchingCandidates = candidateRows.filter(
          (c) => c.concept === cur.concept && c.unit === cur.unit,
        );
        if (matchingCandidates.length === 0) continue;

        const curEndMs = Date.parse(cur.periodEnd);
        const curStartMs = cur.periodStart ? Date.parse(cur.periodStart) : NaN;
        const curDurationDays =
          !isNaN(curStartMs) && !isNaN(curEndMs)
            ? (curEndMs - curStartMs) / (1000 * 3600 * 24)
            : null;

        // 1. Select YoY (same quarter / period of previous year)
        let yoyCandidate: (typeof matchingCandidates)[0] | undefined;
        if (cur.fiscalYear && cur.fiscalPeriod) {
          yoyCandidate = matchingCandidates.find(
            (c) =>
              c.fiscal_year === cur.fiscalYear! - 1 &&
              c.fiscal_period === cur.fiscalPeriod,
          );
        }
        if (!yoyCandidate && !isNaN(curEndMs)) {
          yoyCandidate = matchingCandidates.find((c) => {
            const cEndMs = Date.parse(c.period_end);
            if (isNaN(cEndMs)) return false;
            const diffDays = (curEndMs - cEndMs) / (1000 * 3600 * 24);
            if (diffDays < 300 || diffDays > 430) return false;
            if (curDurationDays !== null && c.period_start) {
              const cStartMs = Date.parse(c.period_start);
              if (!isNaN(cStartMs)) {
                const cDurationDays = (cEndMs - cStartMs) / (1000 * 3600 * 24);
                if (Math.abs(cDurationDays - curDurationDays) > 35)
                  return false;
              }
            }
            return true;
          });
        }

        if (yoyCandidate) {
          priorYearFactsMap.set(cur.concept, {
            taxonomy: yoyCandidate.taxonomy,
            concept: yoyCandidate.concept,
            label: yoyCandidate.concept,
            unit: yoyCandidate.unit,
            val: yoyCandidate.val,
            periodStart: yoyCandidate.period_start ?? undefined,
            periodEnd: yoyCandidate.period_end,
            fiscalYear: yoyCandidate.fiscal_year ?? undefined,
            fiscalPeriod: yoyCandidate.fiscal_period ?? undefined,
            filedDate: "",
            accessionNumber: "",
            factId: yoyCandidate.id,
            secUrl: yoyCandidate.sec_url,
          });
        }

        // 2. Select QoQ (sequential previous quarter)
        let qoqCandidate: (typeof matchingCandidates)[0] | undefined;
        if (cur.fiscalYear && cur.fiscalPeriod) {
          let targetQoqYear = cur.fiscalYear;
          let targetQoqPeriod: string | undefined;
          if (cur.fiscalPeriod === "Q2") targetQoqPeriod = "Q1";
          else if (cur.fiscalPeriod === "Q3") targetQoqPeriod = "Q2";
          else if (cur.fiscalPeriod === "Q4") targetQoqPeriod = "Q3";
          else if (cur.fiscalPeriod === "Q1") {
            targetQoqPeriod = "Q4";
            targetQoqYear = cur.fiscalYear - 1;
          }

          if (targetQoqPeriod) {
            qoqCandidate = matchingCandidates.find(
              (c) =>
                c.fiscal_year === targetQoqYear &&
                c.fiscal_period === targetQoqPeriod,
            );
          }
        }

        if (!qoqCandidate && !isNaN(curEndMs)) {
          qoqCandidate = matchingCandidates.find((c) => {
            const cEndMs = Date.parse(c.period_end);
            if (isNaN(cEndMs)) return false;
            const diffDays = (curEndMs - cEndMs) / (1000 * 3600 * 24);
            if (diffDays < 55 || diffDays > 125) return false;
            if (curDurationDays !== null && c.period_start) {
              const cStartMs = Date.parse(c.period_start);
              if (!isNaN(cStartMs)) {
                const cDurationDays = (cEndMs - cStartMs) / (1000 * 3600 * 24);
                if (Math.abs(cDurationDays - curDurationDays) > 35)
                  return false;
              }
            }
            return true;
          });
        }

        if (qoqCandidate) {
          priorFactsMap.set(cur.concept, {
            taxonomy: qoqCandidate.taxonomy,
            concept: qoqCandidate.concept,
            label: qoqCandidate.concept,
            unit: qoqCandidate.unit,
            val: qoqCandidate.val,
            periodStart: qoqCandidate.period_start ?? undefined,
            periodEnd: qoqCandidate.period_end,
            fiscalYear: qoqCandidate.fiscal_year ?? undefined,
            fiscalPeriod: qoqCandidate.fiscal_period ?? undefined,
            filedDate: "",
            accessionNumber: "",
            factId: qoqCandidate.id,
            secUrl: qoqCandidate.sec_url,
          });
        }
      }

      calculatedMetrics = compareFinancialMetrics(
        currentFactsForComp,
        priorFactsMap,
        priorYearFactsMap,
      );
    }
  }

  const material: ArtifactEventMaterial = {
    eventId,
    eventTitle: articleMaterials[0]?.title || event.event_title,
    industryName: event.industry_name,
    industrySlug: event.industry_slug,
    disclaimer: event.industry_disclaimer,
    articles: articleMaterials,
    verifiedClaims,
    filing: filingMaterial,
    financialFacts: financialFactsList,
    calculatedMetrics,
  };

  // 4. Compute deterministic inputSha over all approved inputs (including verified claims & facts)
  const inputPayload = JSON.stringify({
    eventId,
    inputRevision,
    articles: articleMaterials.map((a) => ({
      id: a.id,
      title: a.title,
      summary: a.summary,
      bodyExcerpt: a.bodyText ? a.bodyText.slice(0, 500) : "",
    })),
    verifiedClaims: verifiedClaims.map((c) => ({
      id: c.id,
      text: c.claimText,
      consensus: c.consensusStatus,
    })),
    financialFacts: financialFactsList.map((f) => ({
      concept: f.concept,
      val: f.val,
      periodEnd: f.periodEnd,
    })),
    calculatedMetrics: (calculatedMetrics || []).map((m) => ({
      concept: m.concept,
      unit: m.unit,
      reportedValue: m.reportedValue,
      reportedCitation: m.reportedCitation,
      priorPeriodValue: m.priorPeriodValue,
      priorPeriodCitation: m.priorPeriodCitation,
      priorYearValue: m.priorYearValue,
      priorYearCitation: m.priorYearCitation,
      deltaQoQPercent: m.deltaQoQPercent,
      deltaYoYPercent: m.deltaYoYPercent,
    })),
    disclaimer: event.industry_disclaimer,
  });
  const inputSha = (await sha256Hex(inputPayload)).slice(0, 16);

  // 5. Determine initial publication status
  const isFinance = event.industry_slug === FINANCE_SLUG;
  const isAuto = !isFinance && event.industry_publish_mode === "auto";
  const initialStatus = isAuto ? "published" : "pending_review";

  let generatedCount = 0;

  // 6. Generate each eligible artifact
  for (const def of Object.values(ARTIFACT_REGISTRY)) {
    if (!def.isEligible(eligibilityCtx)) {
      continue;
    }

    for (const aud of def.audiences) {
      // Check if this artifact already exists for (event_id, type, audience, input_revision)
      const existing = await deps.db
        .prepare(
          `SELECT id FROM event_artifacts
           WHERE event_id = ?1 AND type = ?2 AND audience = ?3 AND input_revision = ?4`,
        )
        .bind(eventId, def.type, aud, inputRevision)
        .first<{ id: number }>();

      if (existing) {
        continue;
      }

      const req = def.buildRequest(material, aud);
      const logicalKey = `artifact:${eventId}:${def.type}:${aud || "default"}:${inputRevision}:${inputSha}:${def.promptVersion}`;

      const slot = def.slot ?? "write";
      const res = await deps.models.generateText(slot, logicalKey, req);

      // Verify completion reason
      if (res.finishReason !== "STOP") {
        console.warn({
          warning: "artifact generation finishReason was not STOP",
          eventId,
          type: def.type,
          audience: aud,
          finishReason: res.finishReason,
        });
      }

      // Validate output schema
      const parsed = def.parseOutput(res.text, aud, material);
      if (!parsed) {
        console.error({
          error: "failed to parse artifact output against schema",
          eventId,
          type: def.type,
          audience: aud,
          rawText: res.text.slice(0, 200),
        });
        continue;
      }

      const contentJson = JSON.stringify(parsed);
      const artifactModel = slot === "reason" ? reasonModelName : modelName;

      // Atomic conditional insert: only write if events.revision is still inputRevision
      const insertResult = await deps.db
        .prepare(
          `INSERT INTO event_artifacts (
             event_id, type, audience, input_revision, prompt_version, model, content, status, created_at
           )
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
           WHERE (SELECT revision FROM events WHERE id = ?1) = ?4
           ON CONFLICT (event_id, type, audience, input_revision, prompt_version, model) DO NOTHING`,
        )
        .bind(
          eventId,
          def.type,
          aud,
          inputRevision,
          def.promptVersion,
          artifactModel,
          contentJson,
          initialStatus,
          deps.now(),
        )
        .run();

      if (insertResult.meta.changes === 1) {
        generatedCount++;
      } else {
        console.warn({
          warning:
            "artifact insertion condition failed: event revision changed during generation",
          eventId,
          inputRevision,
        });
      }
    }
  }

  // Ensure revision_diff artifact exists for updates (inputRevision > 1) (N§2.2)
  if (inputRevision > 1) {
    for (let r = 2; r <= inputRevision; r++) {
      await syncRevisionDiff(deps.db, eventId, r, initialStatus, deps.now());
    }
  }

  return {
    status: generatedCount > 0 ? "generated" : "already_up_to_date",
    eventId,
    inputRevision,
    generatedCount,
  };
}
