// Handler for `body` messages: fetch an article body up the ladder, store it
// as a new R2 version, and move the article to body_ready.
//
//   COLLECT_ENABLED -> stage = collected (unless force) -> rung 0 (no request)
//     -> host in site_domain / primary_domains -> robots.txt -> crawl slot
//     -> rungs 1+2 (each redirect hop: the same gates), 3 -> else "summary only"
//     -> R2 bodies/{id}/{sha256}.md (head first: never overwritten)
//     -> one batch(): articles (stage condition) + sources (probe)
//     -> `analyze` message if this call moved the stage
//
// Any failed gate means no request at all; the article goes on with its
// feed summary (body_kind 'summary'), so body_sha is never null. A taken
// crawl slot (also of a redirect hop) sends the message again with a delay.
import { isEnabled } from "../../lib/flags";
import { createModelClient } from "../../providers/models";
import { CALL_TIERS } from "../../providers/tiers";
import type { ModelClient } from "../../providers/models";
import { jinaTransport } from "../../providers/jina";
import { prefixTransport } from "../../providers/transport";
import { parseSourceConfig } from "../collect/config";
import type { SourceConfig } from "../collect/config";
import type { PipelineEnv } from "../messages";
import { fetchPage, MAX_BODY_BYTES, readFeed, readWithJina } from "./ladder";
import type { LadderArticle, LadderBody, LadderDeps } from "./ladder";
import { checkRobots, claimHostSlot, hostAllowed } from "./robots";

/** Injected like CollectDeps: production uses fetch and env.AI. */
export type BodyDeps = LadderDeps;

/** Failures at the recorded rung that clear it (re-probe). */
export const RUNG_FAIL_LIMIT = 3;
/** Queues delaySeconds maximum (12 hours). */
const MAX_DELAY_S = 43_200;

export type BodyResult =
  | { status: "disabled" | "skipped" }
  | { status: "deferred"; delaySeconds: number }
  | {
      status: "ok";
      kind: "full" | "summary";
      rung: LadderBody["rung"] | null;
      sha: string;
      /** False if another delivery moved the stage first. */
      advanced: boolean;
    };

interface Row {
  id: number;
  url: string;
  canonical_url: string;
  title: string;
  summary: string | null;
  stage: string;
  source_id: number;
  config: string;
  site_domain: string | null;
  fetch_rung: number | null;
  jina_enabled: number;
  primary_domains: string;
}

export async function processBody(
  env: PipelineEnv,
  articleId: number,
  now: number,
  deps: BodyDeps,
  opts: { force?: boolean } = {},
): Promise<BodyResult> {
  const force = opts.force === true;
  if (!isEnabled(env, "COLLECT_ENABLED")) return { status: "disabled" };
  const row = await env.DB.prepare(
    `SELECT a.id, a.url, a.canonical_url, a.title, a.summary, a.stage,
       s.id AS source_id, s.config, s.site_domain, s.fetch_rung, s.jina_enabled,
       i.primary_domains
     FROM articles AS a
       JOIN sources AS s ON s.id = a.source_id
       JOIN industries AS i ON i.id = a.industry_id
     WHERE a.id = ?1`,
  )
    .bind(articleId)
    .first<Row>();
  // Duplicate delivery: the stage is done.
  if (!row || (!force && row.stage !== "collected")) {
    return { status: "skipped" };
  }
  const article: LadderArticle = {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    summary: row.summary,
  };

  let body = await readFeed(env, article, sourceConfig(row.config), deps);
  let reason: string | null = null;
  let probe: Probe | null = null;
  if (!body) {
    const gate = await openGates(env, row, now, deps);
    if (gate.kind === "deferred") {
      return defer(env, articleId, gate.delaySeconds, force);
    }
    if (gate.kind === "blocked") {
      reason = gate.reason;
    } else {
      const fetched = await fetchRemote(env, row, article, now, gate, deps);
      // The page fetch is the first request: nothing is written yet.
      if (fetched.kind === "deferred") {
        return defer(env, articleId, fetched.delaySeconds, force);
      }
      body = fetched.body;
      probe = fetched.probe;
      if (!body) reason = fetched.reason;
    }
  }

  const kind = body ? "full" : "summary";
  const rung = body?.rung ?? null;
  const cut = capBytes(body?.markdown ?? summaryBody(row), MAX_BODY_BYTES);
  const truncated = cut.truncated || (body?.truncated ?? false);
  const markdown = cut.text;
  const sha = await sha256Hex(markdown);
  const key = `bodies/${articleId}/${sha}.md`;
  // Never overwrite: same content = same key = already stored.
  if (!(await env.BODIES.head(key))) {
    await env.BODIES.put(key, markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: {
        rung: rung === null ? "summary" : String(rung),
        url: row.url,
        fetchedAt: String(now),
      },
    });
  }

  const columns = [sha, kind, rung, truncated ? 1 : 0, now] as const;
  const statements = [
    // Architecture §5: writing stage also writes stage_updated_at and
    // requeue_count.
    env.DB.prepare(
      `UPDATE articles SET body_sha = ?2, body_kind = ?3, fetch_rung = ?4,
         body_truncated = ?5, body_fetched_at = ?6, stage = 'body_ready',
         stage_updated_at = ?6, requeue_count = 0
       WHERE id = ?1 AND stage = 'collected'`,
    ).bind(articleId, ...columns),
  ];
  if (force) {
    // Re-fetch of a later stage: new body version, the stage stays.
    statements.push(
      env.DB.prepare(
        `UPDATE articles SET body_sha = ?2, body_kind = ?3, fetch_rung = ?4,
           body_truncated = ?5, body_fetched_at = ?6
         WHERE id = ?1 AND stage != 'collected'`,
      ).bind(articleId, ...columns),
    );
  }
  if (probe) statements.push(probeStatement(env, probe, articleId, sha, now));
  const [moved] = await env.DB.batch(statements);
  const advanced = moved.meta.changes === 1;
  if (advanced) await env.Q_INGEST.send({ kind: "analyze", articleId });

  console.log({ body: articleId, kind, rung, truncated, reason, advanced });
  return { status: "ok", kind, rung, sha, advanced };
}

/** Sends the message again after the crawl-delay wait, capped. */
async function defer(
  env: PipelineEnv,
  articleId: number,
  waitSec: number,
  force: boolean,
): Promise<BodyResult> {
  const delaySeconds = Math.min(Math.max(waitSec, 1), MAX_DELAY_S);
  if (!force) {
    await env.Q_INGEST.send({ kind: "body", articleId }, { delaySeconds });
  }
  console.log({ body: articleId, deferred: delaySeconds });
  return { status: "deferred", delaySeconds };
}

type Gate =
  | { kind: "open"; domains: string[] }
  | { kind: "blocked"; reason: string }
  | { kind: "deferred"; delaySeconds: number };

/** Architecture §8 / #6 invariant 1, in this order. */
async function openGates(
  env: PipelineEnv,
  row: Row,
  now: number,
  deps: BodyDeps,
): Promise<Gate> {
  // #8 fills site_domain. Without it the source has no whitelist entry:
  // no fallback to the feed host (rss.arxiv.org is not arxiv.org).
  if (!row.site_domain?.trim()) {
    return { kind: "blocked", reason: "no_site_domain" };
  }
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    return { kind: "blocked", reason: "bad_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { kind: "blocked", reason: "bad_url" };
  }
  const domains = [row.site_domain, ...primaryDomains(row.primary_domains)];
  if (!hostAllowed(url.hostname, domains)) {
    return { kind: "blocked", reason: "host_not_allowed" };
  }
  const robots = await checkRobots(env, url.href, now, deps.fetch, domains);
  if (!robots.allowed) return { kind: "blocked", reason: "robots_disallowed" };
  const slot = await claimHostSlot(
    env,
    url.host,
    robots.crawlDelaySec ?? 0,
    now,
  );
  if (!slot.claimed) return { kind: "deferred", delaySeconds: slot.waitSec };
  return { kind: "open", domains };
}

interface Probe {
  sourceId: number;
  /** sources.fetch_rung when the article was read; null = probing. */
  recorded: number | null;
  /** The first rung tried succeeded. */
  firstOk: boolean;
  rung: number | null;
}

/**
 * Rungs 1-3 from max(1, sources.fetch_rung ?? 1) upwards. Rungs 1 and 2 are
 * one request, so a recorded 1 or 2 is "the page fetch". A redirect the
 * gates block ends the ladder (no Jina) and counts as a failed page fetch.
 */
async function fetchRemote(
  env: PipelineEnv,
  row: Row,
  article: LadderArticle,
  now: number,
  gate: { domains: string[] },
  deps: BodyDeps,
): Promise<
  | { kind: "deferred"; delaySeconds: number }
  | { kind: "done"; body: LadderBody | null; probe: Probe; reason: string }
> {
  const recorded =
    row.fetch_rung !== null && row.fetch_rung >= 1 && row.fetch_rung <= 3
      ? row.fetch_rung
      : null;
  const start = Math.max(1, recorded ?? 1);
  let body: LadderBody | null = null;
  let firstOk = false;
  let blocked = false;
  if (start <= 2) {
    const page = await fetchPage(env, article.url, now, gate.domains, deps);
    if (page.kind === "deferred") return page;
    if (page.kind === "body") body = page.body;
    blocked = page.kind === "blocked";
    firstOk = body !== null;
  }
  if (!body && !blocked) {
    let models: ModelClient | null = null;
    body = await readWithJina(env, article, row.jina_enabled === 1, () => {
      models ??= createModelClient({
        tier: CALL_TIERS.body,
        db: env.DB,
        transport: prefixTransport({
          "jina/": jinaTransport({
            apiKey: env.JINA_API_KEY ?? "",
            fetch: deps.fetch,
          }),
        }),
        env,
        now: () => now,
      });
      return models;
    });
    if (start === 3) firstOk = body !== null;
  }
  return {
    kind: "done",
    body,
    reason: blocked ? "redirect_blocked" : "all_rungs_failed",
    probe: {
      sourceId: row.source_id,
      recorded,
      firstOk,
      rung: body?.rung ?? null,
    },
  };
}

/**
 * Probe bookkeeping on `sources`. Runs in the article batch and only if
 * that batch wrote this body (body_fetched_at = now, body_sha = sha), so a
 * lost duplicate counts nothing.
 */
function probeStatement(
  env: PipelineEnv,
  probe: Probe,
  articleId: number,
  sha: string,
  now: number,
): D1PreparedStatement {
  const wrote = `EXISTS (SELECT 1 FROM articles WHERE id = ?2
      AND body_fetched_at = ?3 AND body_sha = ?4)`;
  if (probe.recorded === null) {
    return env.DB.prepare(
      `UPDATE sources SET fetch_rung = ?5, rung_fail_count = 0
       WHERE id = ?1 AND fetch_rung IS NULL AND ?5 IS NOT NULL AND ${wrote}`,
    ).bind(probe.sourceId, articleId, now, sha, probe.rung);
  }
  if (probe.firstOk) {
    return env.DB.prepare(
      `UPDATE sources SET rung_fail_count = 0
       WHERE id = ?1 AND fetch_rung = ?5 AND ${wrote}`,
    ).bind(probe.sourceId, articleId, now, sha, probe.recorded);
  }
  // SET reads the old values: both columns see the same count.
  return env.DB.prepare(
    `UPDATE sources SET
       fetch_rung = CASE WHEN rung_fail_count + 1 >= ?6 THEN NULL
         ELSE fetch_rung END,
       rung_fail_count = CASE WHEN rung_fail_count + 1 >= ?6 THEN 0
         ELSE rung_fail_count + 1 END
     WHERE id = ?1 AND fetch_rung = ?5 AND ${wrote}`,
  ).bind(probe.sourceId, articleId, now, sha, probe.recorded, RUNG_FAIL_LIMIT);
}

/** "Summary only": `# {title}\n\n{summary}`, or `# {title}`. */
function summaryBody(row: Pick<Row, "title" | "summary">): string {
  const summary = row.summary?.trim() ?? "";
  return summary === "" ? `# ${row.title}` : `# ${row.title}\n\n${summary}`;
}

function sourceConfig(json: string): SourceConfig {
  try {
    return parseSourceConfig(json);
  } catch {
    return {};
  }
}

function primaryDomains(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((d): d is string => typeof d === "string")
      : [];
  } catch {
    return [];
  }
}

/** At most `maxBytes` of UTF-8, cut on a character boundary. */
function capBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  const cut = new TextDecoder().decode(bytes.subarray(0, maxBytes));
  return { text: cut.replace(/�+$/, ""), truncated: true };
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
