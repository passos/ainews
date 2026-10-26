import { eq, sql, and, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { isEnabled } from "../../lib/flags";
import { isSystemSource } from "../../lib/source-attribution";
import {
  createModelClient,
  type ModelClient,
  BudgetExceededError,
} from "../../providers/models";
import {
  bindingTransport,
  type ModelTransport,
} from "../../providers/transport";
import type { PipelineEnv } from "../messages";
import {
  discoveryRuns,
  sourceCandidates,
  sources,
  industries,
  llmCalls,
} from "../../server/db/schema";
import { parseAnalysisConfig, type AnalysisConfig } from "../analyze/config";
import { FINANCE_SLUG } from "../analyze/analyze";
import { WRITE_THINKING } from "../analyze/prompts";
import { probeCandidate } from "./probe";
import { evaluateCandidateSamples } from "./score";
import type { ToMarkdown } from "../body/ladder";

export interface WebSearchItem {
  url: string;
  title?: string;
  snippet?: string;
}

export interface WebSearchResponse {
  items: WebSearchItem[];
}

export interface WebSearchClient {
  search(options: {
    query: string;
    limit?: number;
  }): Promise<WebSearchResponse>;
}

export function createWebSearchClient(
  ai?: Env["AI"],
  gatewayId?: string,
): WebSearchClient | null {
  if (
    !ai ||
    typeof (ai as unknown as { websearch?: unknown }).websearch !== "function"
  ) {
    return null;
  }
  return {
    async search(options: { query: string; limit?: number }) {
      const res = await (
        ai as unknown as {
          websearch: (req: unknown) => Promise<unknown>;
        }
      ).websearch({
        gatewayId: gatewayId ?? "ainews",
        query: options.query,
        limit: options.limit ?? 10,
      });
      if (res && typeof (res as Response).json === "function") {
        return (await (res as Response).json()) as WebSearchResponse;
      }
      return res as WebSearchResponse;
    },
  };
}

export interface DiscoverDeps {
  db?: D1Database;
  webSearch?: WebSearchClient;
  transport?: ModelTransport;
  models?: ModelClient;
  fetch?: typeof fetch;
  toMarkdown?: ToMarkdown;
  now?: () => number;
}

const MAX_ACTIVE_SOURCES_PER_INDUSTRY = 50;
const MAX_CANDIDATES_TO_PROBE = 10;

function parseSearchQueries(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (q): q is string => typeof q === "string" && q.trim().length > 0,
      );
    }
  } catch {
    // not json array
  }
  return [];
}

export async function runDiscovery(
  env: PipelineEnv,
  runId: number,
  nowMs = Date.now(),
  overrides: DiscoverDeps = {},
): Promise<void> {
  const db = drizzle(overrides.db ?? env.DB);

  // 1. Guard check: DISCOVERY_ENABLED safety flag
  if (!isEnabled(env, "DISCOVERY_ENABLED")) {
    await db
      .update(discoveryRuns)
      .set({
        status: "skipped",
        error: "DISCOVERY_ENABLED is false",
        completedAt: nowMs,
      })
      .where(eq(discoveryRuns.id, runId));
    return;
  }

  // 2. Fetch run record
  const runRows = await db
    .select()
    .from(discoveryRuns)
    .where(eq(discoveryRuns.id, runId));
  const run = runRows[0];
  if (!run || run.status === "completed" || run.status === "skipped") {
    return;
  }

  // Set to running
  await db
    .update(discoveryRuns)
    .set({ status: "running" })
    .where(eq(discoveryRuns.id, runId));

  const nowFn = overrides.now ?? (() => nowMs);
  const fetchFn = overrides.fetch ?? globalThis.fetch.bind(globalThis);
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
      db: overrides.db ?? env.DB,
      transport,
      env,
      now: nowFn,
    });

  const webSearch =
    overrides.webSearch ?? createWebSearchClient(env.AI, env.AI_GATEWAY_ID);
  if (!webSearch) {
    await db
      .update(discoveryRuns)
      .set({
        status: "failed",
        error: "WebSearch service not available",
        completedAt: nowFn(),
      })
      .where(eq(discoveryRuns.id, runId));
    return;
  }

  try {
    // Fetch industry
    const indRows = await db
      .select()
      .from(industries)
      .where(eq(industries.id, run.industryId));
    const ind = indRows[0];
    if (!ind) {
      await db
        .update(discoveryRuns)
        .set({
          status: "failed",
          error: "Industry not found",
          completedAt: nowFn(),
        })
        .where(eq(discoveryRuns.id, runId));
      return;
    }

    const config: AnalysisConfig | null = parseAnalysisConfig(ind.config);
    const selectThreshold = config?.thresholds?.select ?? 50;

    // 3. Search queries
    let queries = parseSearchQueries(run.searchQueries);
    if (queries.length === 0) {
      const prompt = `Generate 3 web search queries to discover high-quality RSS feeds, trade blogs, and industry news sources for section: ${ind.name}.
Editorial criteria: ${config?.prefilter?.relevant ?? ind.name}.
Return a strictly valid JSON array of strings, for example: ["query 1", "query 2", "query 3"]. Output ONLY JSON.`;

      const key = `discover_queries:${runId}:${ind.id}`;
      try {
        const queryRes = await models.generateText("reason", key, {
          system:
            "You generate web search queries for finding industry news RSS feeds.",
          prompt,
          maxOutputTokens: 500,
          thinkingConfig: WRITE_THINKING,
        });
        let raw = queryRes.text.trim();
        if (raw.startsWith("```")) {
          raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        }
        queries = parseSearchQueries(raw);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        // Fallback queries
        queries = [
          `${ind.name} industry news RSS feed`,
          `${ind.name} announcements blog feed`,
          `${ind.name} publications articles`,
        ];
      }

      if (queries.length === 0) {
        queries = [
          `${ind.name} industry news RSS feed`,
          `${ind.name} announcements blog feed`,
        ];
      }

      await db
        .update(discoveryRuns)
        .set({ searchQueries: JSON.stringify(queries) })
        .where(eq(discoveryRuns.id, runId));
    }

    // 4. Web Search
    const discoveredUrls: string[] = [];
    for (const query of queries) {
      try {
        const res = await webSearch.search({ query, limit: 10 });
        for (const item of res.items) {
          const url = typeof item.url === "string" ? item.url.trim() : "";
          if (url && !discoveredUrls.includes(url)) {
            discoveredUrls.push(url);
          }
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
      }
    }

    // Filter existing sources
    const existingSources = await db
      .select({ feedUrl: sources.feedUrl, siteDomain: sources.siteDomain })
      .from(sources)
      .where(eq(sources.industryId, ind.id));

    const existingFeeds = new Set(existingSources.map((s) => s.feedUrl));
    const candidateUrls = discoveredUrls.filter((u) => !existingFeeds.has(u));

    const candidatesFound = candidateUrls.length;
    let candidatesAdded = 0;
    let candidatesAutoEnabled = 0;

    const isFinance = ind.slug.trim().toLowerCase() === FINANCE_SLUG;

    const getRunCost = async () => {
      const costRes = await db
        .select({ totalCost: sql<number>`coalesce(sum(cost_micros), 0)` })
        .from(llmCalls)
        .where(
          or(
            eq(llmCalls.logicalKey, `discover_queries:${runId}:${ind.id}`),
            sql`logical_key LIKE ${`discover_score:${runId}:%`}`,
          ),
        );
      return Number(costRes[0]?.totalCost ?? 0);
    };

    // 5. Probe candidates
    const probeTargets = candidateUrls.slice(0, MAX_CANDIDATES_TO_PROBE);
    for (const targetUrl of probeTargets) {
      // System placeholder feeds are reserved: never probe one.
      if (isSystemSource(targetUrl)) continue;

      // Check discovery task budget limit ($0.05 = 50,000 micros)
      const currentRunCost = await getRunCost();
      if (currentRunCost >= 50_000) {
        break;
      }

      const probeRes = await probeCandidate(
        targetUrl,
        { DB: overrides.db ?? env.DB },
        {
          fetch: fetchFn,
          toMarkdown: overrides.toMarkdown,
          now: nowFn,
        },
      );

      // If feed already exists in sources for this industry, do NOT score or duplicate
      if (existingFeeds.has(probeRes.feedUrl)) {
        continue;
      }
      // The probe can follow a page link to a system: feed; skip it too.
      if (isSystemSource(probeRes.feedUrl)) continue;

      let sampleScores: number[] = [];
      let avgScore: number | null = null;
      let candidateStatus:
        "pending" | "approved" | "rejected" | "auto_enabled" = "pending";
      let rejectionReason: string | null = null;

      if (probeRes.rejectionReason === "rate_limited") {
        candidateStatus = "pending";
        rejectionReason = "rate_limited";
      } else if (probeRes.requiresBrowser === 1) {
        candidateStatus = "rejected";
        rejectionReason = probeRes.rejectionReason || "requires_browser";
      } else if (probeRes.kind !== "rss") {
        candidateStatus = "rejected";
        rejectionReason = "no_rss_feed";
      } else if (config) {
        const evalRes = await evaluateCandidateSamples(
          probeRes.sampleArticles,
          ind.name,
          config,
          { models, runId },
        );
        sampleScores = evalRes.sampleScores;
        avgScore = evalRes.avgScore;

        if (avgScore < selectThreshold) {
          candidateStatus = "rejected";
          rejectionReason = "below_threshold";
        } else if (isFinance) {
          // Invariant 3: Finance NEVER auto-enables
          candidateStatus = "pending";
          rejectionReason = "finance_requires_review";
        } else {
          // Re-verify live active count from DB to prevent race conditions
          const liveActiveRes = await db
            .select({ count: sql<number>`count(*)` })
            .from(sources)
            .where(
              and(eq(sources.industryId, ind.id), eq(sources.status, "active")),
            );
          const liveActiveCount = Number(liveActiveRes[0]?.count ?? 0);

          if (liveActiveCount >= MAX_ACTIVE_SOURCES_PER_INDUSTRY) {
            // Invariant 2: 50 active sources cap
            candidateStatus = "pending";
            rejectionReason = "active_cap_reached";
          } else {
            // Eligible for auto-enable!
            candidateStatus = "auto_enabled";
          }
        }
      }

      // Upsert candidate record
      const sampleUrls = probeRes.sampleArticles.map((s) => s.url);
      const existingCandidate = await db
        .select()
        .from(sourceCandidates)
        .where(
          and(
            eq(sourceCandidates.industryId, ind.id),
            eq(sourceCandidates.feedUrl, probeRes.feedUrl),
          ),
        );

      const wasDecidedByAdmin =
        existingCandidate[0]?.status === "approved" ||
        existingCandidate[0]?.status === "rejected";

      if (wasDecidedByAdmin) {
        candidateStatus = existingCandidate[0].status;
        rejectionReason = existingCandidate[0].rejectionReason;
      }

      if (existingCandidate.length > 0) {
        await db
          .update(sourceCandidates)
          .set({
            runId,
            name: probeRes.name,
            siteDomain: probeRes.siteDomain,
            kind: probeRes.kind,
            fetchRung: probeRes.fetchRung,
            sampleUrls: JSON.stringify(sampleUrls),
            sampleScores: JSON.stringify(sampleScores),
            avgScore,
            requiresBrowser: probeRes.requiresBrowser,
            status: candidateStatus,
            rejectionReason,
          })
          .where(eq(sourceCandidates.id, existingCandidate[0].id));
      } else {
        await db.insert(sourceCandidates).values({
          runId,
          industryId: ind.id,
          name: probeRes.name,
          feedUrl: probeRes.feedUrl,
          siteDomain: probeRes.siteDomain,
          kind: probeRes.kind,
          fetchRung: probeRes.fetchRung,
          sampleUrls: JSON.stringify(sampleUrls),
          sampleScores: JSON.stringify(sampleScores),
          avgScore,
          requiresBrowser: probeRes.requiresBrowser,
          status: candidateStatus,
          rejectionReason,
          createdAt: nowFn(),
        });
        candidatesAdded++;
      }

      // Auto-enable into sources atomically if passed and not overridden by admin
      if (candidateStatus === "auto_enabled" && !wasDecidedByAdmin) {
        const rawDb = overrides.db ?? env.DB;
        const insertRes = await rawDb
          .prepare(
            `INSERT INTO sources (industry_id, name, feed_url, site_domain, kind, status, fetch_rung, interval_minutes, created_at)
             SELECT ?1, ?2, ?3, ?4, ?5, 'active', ?6, 60, ?7
             WHERE (SELECT count(*) FROM sources WHERE industry_id = ?1 AND status = 'active') < 50
             ON CONFLICT (industry_id, feed_url) DO UPDATE SET status = 'active'
             WHERE (SELECT count(*) FROM sources WHERE industry_id = excluded.industry_id AND status = 'active') < 50`,
          )
          .bind(
            ind.id,
            probeRes.name || probeRes.siteDomain || "",
            probeRes.feedUrl,
            probeRes.siteDomain,
            probeRes.kind,
            probeRes.fetchRung,
            nowFn(),
          )
          .run();

        if (insertRes.meta.changes > 0) {
          candidatesAutoEnabled++;
          existingFeeds.add(probeRes.feedUrl);
        } else {
          // 50 active sources cap reached concurrently! Revert to pending
          candidateStatus = "pending";
          rejectionReason = "active_cap_reached";
          await db
            .update(sourceCandidates)
            .set({ status: candidateStatus, rejectionReason })
            .where(
              and(
                eq(sourceCandidates.industryId, ind.id),
                eq(sourceCandidates.feedUrl, probeRes.feedUrl),
              ),
            );
        }
      }
    }

    // 6. Complete run & update cost_micros
    const finalCost = await getRunCost();

    await db
      .update(discoveryRuns)
      .set({
        status: "completed",
        candidatesFound,
        candidatesAdded,
        candidatesAutoEnabled,
        costMicros: finalCost,
        completedAt: nowFn(),
      })
      .where(eq(discoveryRuns.id, runId));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failCost = await db
      .select({ totalCost: sql<number>`coalesce(sum(cost_micros), 0)` })
      .from(llmCalls)
      .where(
        or(
          eq(
            llmCalls.logicalKey,
            `discover_queries:${runId}:${run.industryId}`,
          ),
          sql`logical_key LIKE ${`discover_score:${runId}:%`}`,
        ),
      )
      .then((r) => Number(r[0]?.totalCost ?? 0))
      .catch(() => 0);

    await db
      .update(discoveryRuns)
      .set({
        status: "failed",
        error: errorMsg,
        costMicros: failCost,
        completedAt: nowFn(),
      })
      .where(eq(discoveryRuns.id, runId));

    if (err instanceof BudgetExceededError) {
      // Safe exit on budget exceeded, do not re-throw to DLQ
      return;
    }
    throw err;
  }
}
