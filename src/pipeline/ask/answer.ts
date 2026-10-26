import { isEnabled } from "../../lib/flags";
import { attributeSource } from "../../lib/source-attribution";
import { safeHttpUrl } from "../../lib/url";
import { APPROVED_ARTICLE_SQL } from "../../server/publication/articles";
import { DEFAULT_SLOTS, SETTING_SLOTS } from "../../providers/defaults";
import {
  CallInProgressError,
  createModelClient,
  type ModelClient,
} from "../../providers/models";
import { toMarkdown } from "../../providers/tomarkdown";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import type { PipelineEnv } from "../messages";
import { fetchPage, type LadderDeps, type ToMarkdown } from "../body/ladder";
import { checkRobots, claimHostSlot, hostAllowed } from "../body/robots";
import { sha256Hex } from "../evidence/chunks";
import { isPrimarySourceDomain, verifyQuoteInBody } from "../evidence/verify";
import {
  ASK_PROMPT_VERSION,
  buildAskRequest,
  parseAskOutput,
  type ArticleAskContext,
} from "./prompts";

export const ASK_QUESTION_MAX_COST_MICROS = 50_000;

export interface AskDeps {
  db: D1Database;
  bodies?: R2Bucket;
  vectors?: Pick<VectorizeIndex, "query">;
  models: ModelClient;
  transport?: ModelTransport;
  fetch: typeof fetch;
  toMarkdown?: ToMarkdown;
  now: () => number;
}

export interface VerifiedCitation {
  articleId: number;
  bodySha: string;
  quote: string;
  claim: string;
  startOffset: number;
  endOffset: number;
  verified: boolean;
  isPrimarySource: boolean;
}

export interface SupplementalFetchLog {
  url: string;
  rung: number | null;
  status: "ok" | "blocked" | "failed";
}

export type AnswerQuestionResult =
  | {
      status: "completed";
      questionId: number;
      refusal: boolean;
      citationsCount: number;
      costMicros: number;
    }
  | {
      status: "failed";
      questionId: number;
      reason: string;
    }
  | {
      status: "skipped";
      questionId: number;
      reason: string;
    }
  | {
      status: "not_found";
      questionId: number;
    };

function parsePrimaryDomains(json: string | null): string[] {
  if (!json) return [];
  try {
    const val: unknown = JSON.parse(json);
    return Array.isArray(val)
      ? val.filter((d): d is string => typeof d === "string")
      : [];
  } catch {
    return [];
  }
}

function extractUrlsFromText(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s<>"'()]+)/g;
  const matches = text.match(urlRegex) ?? [];
  const valid: string[] = [];
  for (const m of matches) {
    const cleaned = m.replace(/[.,!?;:)]+$/, "");
    const s = safeHttpUrl(cleaned);
    if (s && !valid.includes(s)) {
      valid.push(s);
    }
  }
  return valid;
}

async function ensureBudgetRemaining(
  db: D1Database,
  questionId: number,
): Promise<number> {
  const costRow = await db
    .prepare(
      `SELECT COALESCE(SUM(cost_micros), 0) AS total_cost
       FROM llm_calls
       WHERE logical_key LIKE ?1`,
    )
    .bind(`ask:%:${questionId}:%`)
    .first<{ total_cost: number }>();
  const total = costRow?.total_cost ?? 0;
  if (total >= ASK_QUESTION_MAX_COST_MICROS) {
    throw new Error("Question budget exceeded");
  }
  return total;
}

function createDefaultDeps(
  env: PipelineEnv,
  overrides: Partial<AskDeps> = {},
): AskDeps {
  const now = overrides.now ?? Date.now;
  const fetchFn = overrides.fetch ?? fetch;
  const transport =
    overrides.transport ??
    (env.AI
      ? bindingTransport(env.AI, env.AI_GATEWAY_ID ?? "")
      : {
          run: () => Promise.reject(new Error("no AI binding")),
        });
  const models =
    overrides.models ??
    createModelClient({
      db: env.DB,
      transport,
      env,
      now,
    });
  const toMarkdownFn =
    overrides.toMarkdown ??
    (env.AI
      ? (bytes, mime, baseUrl) => toMarkdown(env.AI!, bytes, mime, baseUrl)
      : undefined);

  return {
    db: overrides.db ?? env.DB,
    bodies: overrides.bodies ?? env.BODIES,
    vectors: overrides.vectors ?? env.V_CHUNKS,
    models,
    transport,
    fetch: fetchFn,
    toMarkdown: toMarkdownFn,
    now,
  };
}

export async function answerQuestion(
  env: PipelineEnv,
  questionId: number,
  commitNow = Date.now(),
  overrides: Partial<AskDeps> = {},
): Promise<AnswerQuestionResult> {
  const deps = createDefaultDeps(env, overrides);

  // 1. Fetch question record
  interface QuestionRow {
    id: number;
    question: string;
    scope_type: "event" | "global";
    event_id: number | null;
    status: string;
  }

  const qRow = await deps.db
    .prepare(
      `SELECT id, question, scope_type, event_id, status FROM questions WHERE id = ?1`,
    )
    .bind(questionId)
    .first<QuestionRow>();

  if (!qRow) {
    return { status: "not_found", questionId };
  }

  if (qRow.status === "completed") {
    return {
      status: "skipped",
      questionId,
      reason: "already completed",
    };
  }

  // 2. Safety flag check: only update if not already completed
  if (!isEnabled(env, "MODEL_CALLS_ENABLED")) {
    await deps.db
      .prepare(
        `UPDATE questions
         SET status = 'failed', error_message = 'MODEL_CALLS_ENABLED is off', completed_at = ?2
         WHERE id = ?1 AND status != 'completed'`,
      )
      .bind(questionId, commitNow)
      .run();
    return {
      status: "failed",
      questionId,
      reason: "MODEL_CALLS_ENABLED is off",
    };
  }

  // 3. Mark as processing
  await deps.db
    .prepare(
      `UPDATE questions SET status = 'processing' WHERE id = ?1 AND status = 'pending'`,
    )
    .bind(questionId)
    .run();

  try {
    // Check pre-call budget
    await ensureBudgetRemaining(deps.db, questionId);

    // 4. Resolve Reason slot model name
    let reasonModel = DEFAULT_SLOTS.reason.model;
    try {
      const settingRow = await deps.db
        .prepare(`SELECT value_json FROM settings WHERE key = ?1`)
        .bind(SETTING_SLOTS)
        .first<{ value_json: string }>();
      if (settingRow?.value_json) {
        const slots = JSON.parse(settingRow.value_json);
        if (slots.reason?.model) {
          reasonModel = slots.reason.model;
        }
      }
    } catch {
      // Keep fallback
    }

    // 5. Vector Embedding & Retrieval from V_CHUNKS
    const qSha = (await sha256Hex(qRow.question)).slice(0, 16);
    const embedKey = `ask:embed:${questionId}:${qSha}`;
    const candidateArticleIds: number[] = [];

    try {
      const [qVector] = await deps.models.embed(embedKey, [qRow.question]);
      if (deps.vectors && qVector && qVector.length > 0) {
        const searchRes = await deps.vectors.query(qVector, {
          topK: 20,
          returnMetadata: "all",
        });
        for (const match of searchRes.matches ?? []) {
          const artId = Number(match.metadata?.article_id);
          if (artId && !candidateArticleIds.includes(artId)) {
            candidateArticleIds.push(artId);
          }
        }
      }
    } catch (err) {
      console.warn({ questionId, warn: "ask embed/vector query error", err });
    }

    // If scoped to a specific event, include event articles
    if (qRow.scope_type === "event" && qRow.event_id) {
      const eventArtRows = await deps.db
        .prepare(`SELECT article_id FROM event_articles WHERE event_id = ?1`)
        .bind(qRow.event_id)
        .all<{ article_id: number }>();
      for (const r of eventArtRows.results ?? []) {
        if (!candidateArticleIds.includes(r.article_id)) {
          candidateArticleIds.push(r.article_id);
        }
      }
    }

    // 6. Query D1 for Approved Articles ONLY
    interface ApprovedRow {
      id: number;
      title: string;
      summary: string | null;
      body_sha: string;
      source_name: string | null;
      site_domain: string | null;
      feed_url: string;
      canonical_url: string;
      industry_id: number;
      industry_name: string;
      primary_domains: string | null;
    }

    const approvedArticles: ApprovedRow[] = [];
    if (candidateArticleIds.length > 0) {
      const placeholders = candidateArticleIds.map(() => "?").join(", ");
      let sql = `
        SELECT a.id, a.title, a.summary, a.body_sha,
               s.name AS source_name, s.site_domain, s.feed_url, a.canonical_url,
               i.id AS industry_id, i.name AS industry_name, i.primary_domains
        FROM articles a
        JOIN sources s ON s.id = a.source_id
        JOIN industries i ON i.id = a.industry_id
        WHERE a.id IN (${placeholders})
          AND ${APPROVED_ARTICLE_SQL}
      `;

      const bindings: (number | string)[] = [...candidateArticleIds];
      if (qRow.scope_type === "event" && qRow.event_id) {
        sql += ` AND EXISTS (
          SELECT 1 FROM event_articles ea
          WHERE ea.article_id = a.id AND ea.event_id = ?
        )`;
        bindings.push(qRow.event_id);
      }

      const rows = await deps.db
        .prepare(sql)
        .bind(...bindings)
        .all<ApprovedRow>();
      approvedArticles.push(...(rows.results ?? []));
    }

    // 7. Load article bodies - DO NOT fall back to summary!
    const articlesContext: ArticleAskContext[] = [];
    for (const art of approvedArticles) {
      let bodyText = "";
      if (deps.bodies && art.body_sha) {
        try {
          const obj = await deps.bodies.get(
            `bodies/${art.id}/${art.body_sha}.md`,
          );
          if (obj) {
            bodyText = await obj.text();
          }
        } catch (err) {
          console.warn({
            articleId: art.id,
            warn: "failed to load body from R2",
            err,
          });
        }
      }
      // Only include if actual markdown body is present
      if (bodyText) {
        const primaryDomains = parsePrimaryDomains(art.primary_domains);
        const source = attributeSource({
          name: art.source_name ?? "",
          siteDomain: art.site_domain,
          feedUrl: art.feed_url,
          canonicalUrl: art.canonical_url,
        });
        articlesContext.push({
          id: art.id,
          title: art.title,
          sourceName: source.name || art.site_domain || "Source",
          sourceDomain: source.domain,
          isPrimarySource: isPrimarySourceDomain(source.domain, primaryDomains),
          bodySha: art.body_sha,
          bodyText,
        });
      }
    }

    // 8. Initial Reason slot model call
    await ensureBudgetRemaining(deps.db, questionId);

    const scopeDesc =
      qRow.scope_type === "event" ? `Event #${qRow.event_id}` : undefined;
    const req1 = buildAskRequest({
      question: qRow.question,
      scopeDescription: scopeDesc,
      articles: articlesContext,
    });

    const p1Sha = (await sha256Hex(req1.prompt)).slice(0, 16);
    const callKey1 = `ask:reason:${questionId}:r1:${p1Sha}`;
    const res1 = await deps.models.generateText("reason", callKey1, req1);
    let parsedOutput = parseAskOutput(res1.text);

    // 9. Supplementary fetch in whitelist if evidence is insufficient
    const supplementalFetched: SupplementalFetchLog[] = [];
    if (
      parsedOutput &&
      !parsedOutput.sufficient &&
      (parsedOutput.neededUrls.length > 0 ||
        extractUrlsFromText(qRow.question).length > 0)
    ) {
      // Gather candidate URLs (up to 2)
      const rawCandidates = [
        ...parsedOutput.neededUrls,
        ...extractUrlsFromText(qRow.question),
      ];
      const candidateUrls: string[] = [];
      for (const raw of rawCandidates) {
        const s = safeHttpUrl(raw);
        if (s && !candidateUrls.includes(s)) {
          candidateUrls.push(s);
          if (candidateUrls.length >= 2) break;
        }
      }

      if (candidateUrls.length > 0) {
        // Gather allowed domains ONLY from active sources and industries
        const sourceRows = await deps.db
          .prepare(`SELECT site_domain FROM sources WHERE status = 'active'`)
          .all<{ site_domain: string | null }>();
        const industryRows = await deps.db
          .prepare(`SELECT primary_domains FROM industries`)
          .all<{ primary_domains: string | null }>();

        const allowedDomains = new Set<string>();
        for (const s of sourceRows.results ?? []) {
          if (s.site_domain?.trim())
            allowedDomains.add(s.site_domain.trim().toLowerCase());
        }
        for (const ind of industryRows.results ?? []) {
          for (const d of parsePrimaryDomains(ind.primary_domains)) {
            if (d.trim()) allowedDomains.add(d.trim().toLowerCase());
          }
        }
        const domainsList = Array.from(allowedDomains);

        const supplementalDeadline = deps.now() + 15_000;
        const ladderDeps: LadderDeps = {
          fetch: deps.fetch,
          toMarkdown: deps.toMarkdown ?? (async () => null),
        };

        let anyFetched = false;
        for (const targetUrl of candidateUrls) {
          if (deps.now() >= supplementalDeadline) {
            supplementalFetched.push({
              url: targetUrl,
              rung: null,
              status: "blocked",
            });
            break;
          }

          let parsedUrl: URL;
          try {
            parsedUrl = new URL(targetUrl);
          } catch {
            supplementalFetched.push({
              url: targetUrl,
              rung: null,
              status: "blocked",
            });
            continue;
          }

          if (!hostAllowed(parsedUrl.hostname, domainsList)) {
            supplementalFetched.push({
              url: targetUrl,
              rung: null,
              status: "blocked",
            });
            continue;
          }

          const fetchNow = deps.now();

          // robots.txt check
          const robots = await checkRobots(
            env,
            targetUrl,
            fetchNow,
            deps.fetch,
            domainsList,
          );
          if (!robots.allowed) {
            supplementalFetched.push({
              url: targetUrl,
              rung: null,
              status: "blocked",
            });
            continue;
          }

          // host slot crawl-delay claim
          const slot = await claimHostSlot(
            env,
            parsedUrl.host,
            robots.crawlDelaySec ?? 0,
            fetchNow,
          );
          if (!slot.claimed) {
            supplementalFetched.push({
              url: targetUrl,
              rung: null,
              status: "blocked",
            });
            continue;
          }

          try {
            const pageRes = await fetchPage(
              env,
              targetUrl,
              fetchNow,
              domainsList,
              ladderDeps,
            );
            if (pageRes.kind === "body") {
              supplementalFetched.push({
                url: targetUrl,
                rung: pageRes.body.rung,
                status: "ok",
              });
              anyFetched = true;
              const suppSha = (await sha256Hex(pageRes.body.markdown)).slice(
                0,
                16,
              );

              // Persist supplemental body in R2
              if (deps.bodies) {
                await deps.bodies.put(
                  `bodies/supplemental/${suppSha}.md`,
                  pageRes.body.markdown,
                  {
                    customMetadata: {
                      url: targetUrl,
                      fetchedAt: String(commitNow),
                    },
                  },
                );
              }

              articlesContext.push({
                id: 900000 + supplementalFetched.length,
                title: `Supplemental: ${parsedUrl.hostname}`,
                sourceName: parsedUrl.hostname,
                sourceDomain: parsedUrl.hostname,
                isPrimarySource: false,
                bodySha: suppSha,
                bodyText: pageRes.body.markdown,
              });
            } else {
              supplementalFetched.push({
                url: targetUrl,
                rung: null,
                status: pageRes.kind === "blocked" ? "blocked" : "failed",
              });
            }
          } catch {
            supplementalFetched.push({
              url: targetUrl,
              rung: null,
              status: "failed",
            });
          }
        }

        // If new text was fetched, run round 2 reasoning
        if (anyFetched) {
          await ensureBudgetRemaining(deps.db, questionId);

          const req2 = buildAskRequest({
            question: qRow.question,
            scopeDescription: scopeDesc,
            articles: articlesContext,
          });
          const p2Sha = (await sha256Hex(req2.prompt)).slice(0, 16);
          const callKey2 = `ask:reason:${questionId}:r2:${p2Sha}`;
          const res2 = await deps.models.generateText("reason", callKey2, req2);
          const parsed2 = parseAskOutput(res2.text);
          if (parsed2) {
            parsedOutput = parsed2;
          }
        }
      }
    }

    // 10. Citation Verification using verifyQuoteInBody
    const validCitations: VerifiedCitation[] = [];
    const unverifiedNotes: string[] = [...(parsedOutput?.unverified ?? [])];

    let hasTamperedOrMissingQuote = false;

    if (parsedOutput?.citations && parsedOutput.citations.length > 0) {
      for (const cit of parsedOutput.citations) {
        const art = articlesContext.find((a) => a.id === cit.articleId);
        if (!art) {
          hasTamperedOrMissingQuote = true;
          unverifiedNotes.push(
            `Unverified quote for "${cit.claim}": article #${cit.articleId} not in context`,
          );
          continue;
        }

        const v = verifyQuoteInBody(art.bodyText, cit.quote);
        if (v.verified) {
          validCitations.push({
            articleId: art.id,
            bodySha: art.bodySha,
            quote: cit.quote,
            claim: cit.claim,
            startOffset: v.startOffset,
            endOffset: v.endOffset,
            verified: true,
            isPrimarySource: art.isPrimarySource,
          });
        } else {
          hasTamperedOrMissingQuote = true;
          unverifiedNotes.push(
            `Unverified quote for "${cit.claim}": quote not found verbatim in article #${art.id}`,
          );
        }
      }
    }

    // 11. Refusal determination:
    // - If output is null or not sufficient
    // - If verified citations count is 0
    // - If any proposed citation was tampered or unverified (honest refusal to prevent hallucination)
    const isRefusal =
      !parsedOutput ||
      !parsedOutput.sufficient ||
      validCitations.length === 0 ||
      hasTamperedOrMissingQuote;

    let finalAnswer: string;
    if (isRefusal) {
      if (hasTamperedOrMissingQuote) {
        finalAnswer =
          "The model's proposed answer relied on quotations that could not be verified verbatim in the source texts. Refusing to answer to prevent hallucination.";
      } else {
        finalAnswer =
          parsedOutput?.answer && !parsedOutput.sufficient
            ? parsedOutput.answer
            : "Could not find sufficient verified evidence to answer this question.";
      }
    } else {
      finalAnswer = parsedOutput?.answer ?? "";
    }

    if (isRefusal && unverifiedNotes.length === 0) {
      unverifiedNotes.push(
        "No verified evidence found in database for this question.",
      );
    }

    // 12. Calculate total cost for this question from llm_calls
    let totalCostMicros = 0;
    try {
      const costRow = await deps.db
        .prepare(
          `SELECT COALESCE(SUM(cost_micros), 0) AS total_cost
           FROM llm_calls
           WHERE logical_key LIKE ?1`,
        )
        .bind(`ask:%:${questionId}:%`)
        .first<{ total_cost: number }>();
      totalCostMicros = costRow?.total_cost ?? 0;
    } catch {
      // Ignored
    }

    if (totalCostMicros > ASK_QUESTION_MAX_COST_MICROS) {
      await deps.db
        .prepare(
          `UPDATE questions
           SET status = 'failed',
               error_message = 'Question budget exceeded',
               cost_micros = ?2,
               completed_at = ?3
           WHERE id = ?1`,
        )
        .bind(questionId, totalCostMicros, deps.now())
        .run();

      return {
        status: "failed",
        questionId,
        reason: "Question budget exceeded",
      };
    }

    // 13. Persist Question Result
    await deps.db
      .prepare(
        `UPDATE questions
         SET status = 'completed',
             answer = ?2,
             unverified = ?3,
             citations = ?4,
             refusal = ?5,
             supplemental_fetched = ?6,
             cost_micros = ?7,
             prompt_version = ?8,
             model = ?9,
             completed_at = ?10,
             error_message = NULL
         WHERE id = ?1`,
      )
      .bind(
        questionId,
        finalAnswer,
        JSON.stringify(unverifiedNotes),
        JSON.stringify(validCitations),
        isRefusal ? 1 : 0,
        JSON.stringify(supplementalFetched),
        totalCostMicros,
        ASK_PROMPT_VERSION,
        reasonModel,
        deps.now(),
      )
      .run();

    return {
      status: "completed",
      questionId,
      refusal: isRefusal,
      citationsCount: validCitations.length,
      costMicros: totalCostMicros,
    };
  } catch (err: unknown) {
    if (err instanceof CallInProgressError) {
      // Propagate retryable model call in progress error to queue consumer
      throw err;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    await deps.db
      .prepare(
        `UPDATE questions
         SET status = 'failed', error_message = ?2, completed_at = ?3
         WHERE id = ?1`,
      )
      .bind(questionId, errorMsg, deps.now())
      .run();

    return {
      status: "failed",
      questionId,
      reason: errorMsg,
    };
  }
}
