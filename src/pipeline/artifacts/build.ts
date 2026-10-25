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
import type { ArtifactArticleMaterial, ArtifactEventMaterial } from "./prompts";
import { syncRevisionDiff } from "../evidence/diff";

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
  source_domain: string;
  total_score: number | null;
  content_type: string | null;
  evidence_tags: string | null;
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

  // Resolve write slot model name from settings if configured
  let modelName = DEFAULT_SLOTS.write.model;
  const slotVal = (
    slotBatchResult.results?.[0] as { value?: string } | undefined
  )?.value;
  if (slotVal) {
    try {
      const parsed = JSON.parse(slotVal);
      if (parsed?.write?.model) {
        modelName = parsed.write.model;
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

  const material: ArtifactEventMaterial = {
    eventId,
    eventTitle: articleMaterials[0]?.title || event.event_title,
    industryName: event.industry_name,
    industrySlug: event.industry_slug,
    disclaimer: event.industry_disclaimer,
    articles: articleMaterials,
  };

  // 4. Compute deterministic inputSha over all approved inputs
  const inputPayload = JSON.stringify({
    eventId,
    inputRevision,
    articles: articleMaterials.map((a) => ({
      id: a.id,
      title: a.title,
      summary: a.summary,
      bodyExcerpt: a.bodyText ? a.bodyText.slice(0, 500) : "",
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

      const res = await deps.models.generateText("write", logicalKey, req);

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
      const parsed = def.parseOutput(res.text, aud);
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
          modelName,
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
    await syncRevisionDiff(
      deps.db,
      eventId,
      inputRevision,
      initialStatus,
      deps.now(),
    );
  }

  return {
    status: generatedCount > 0 ? "generated" : "already_up_to_date",
    eventId,
    inputRevision,
    generatedCount,
  };
}
