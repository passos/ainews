// Fetch ladder (architecture §8): the rungs, cheapest first. Gates (host
// whitelist, robots, crawl slot) for the first request are in body.ts; the
// redirect hops of a page fetch are gated here, crawl slot included.
//
//   rung 0    feed material, no request: summaryIsBody, or R2 feed/{sha}.html
//   rung 1+2  one GET: text/markdown -> rung 1; text/html, application/pdf
//             -> toMarkdown, rung 2
//   rung 3    Jina Reader through the model client (`read` slot)
import { isEnabled } from "../../lib/flags";
import { fetchLimited } from "../../lib/http";
import type { ModelClient } from "../../providers/models";
import type { MarkdownMime } from "../../providers/tomarkdown";
import { feedKey } from "../collect/collect";
import type { SourceConfig } from "../collect/config";
import type { PipelineEnv } from "../messages";
import {
  checkRobots,
  claimHostSlot,
  hostAllowed,
  MAX_REDIRECTS,
} from "./robots";

/** Single body cap (architecture §8). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Success: at least this many non-whitespace characters. */
export const MIN_BODY_CHARS = 200;
export const PAGE_TIMEOUT_MS = 30_000;
export const PAGE_ACCEPT =
  "text/markdown, text/html;q=0.9, application/pdf;q=0.8";

export type ToMarkdown = (
  bytes: Uint8Array,
  mime: MarkdownMime,
  baseUrl: string,
) => Promise<string | null>;

export interface LadderDeps {
  fetch: typeof fetch;
  toMarkdown: ToMarkdown;
}

export type Rung = 0 | 1 | 2 | 3;

export interface LadderBody {
  markdown: string;
  rung: Rung;
  /** The response was cut at MAX_BODY_BYTES. */
  truncated: boolean;
}

/**
 * Result of the page fetch. blocked: a redirect went to a scheme, host or
 * path the gates do not allow. deferred: a redirect host's crawl slot is
 * taken; no request was sent to it.
 */
export type PageResult =
  | { kind: "body"; body: LadderBody }
  | { kind: "failed" }
  | { kind: "blocked" }
  | { kind: "deferred"; delaySeconds: number };

const FAILED: PageResult = { kind: "failed" };
const BLOCKED: PageResult = { kind: "blocked" };

export interface LadderArticle {
  id: number;
  url: string;
  canonicalUrl: string;
  summary: string | null;
}

export function isBody(markdown: string | null): markdown is string {
  return (
    markdown !== null && markdown.replace(/\s/g, "").length >= MIN_BODY_CHARS
  );
}

/** Rung 0. Sends no request. */
export async function readFeed(
  env: Pick<PipelineEnv, "BODIES">,
  article: LadderArticle,
  config: SourceConfig,
  deps: LadderDeps,
): Promise<LadderBody | null> {
  if (config.summaryIsBody) {
    return isBody(article.summary)
      ? { markdown: article.summary, rung: 0, truncated: false }
      : null;
  }
  const object = await env.BODIES.get(await feedKey(article.canonicalUrl));
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  const markdown = await convert(deps, bytes, "text/html", article.url);
  return isBody(markdown) ? { markdown, rung: 0, truncated: false } : null;
}

/**
 * Rungs 1 and 2: one GET of `url` (already gated by the caller, crawl slot
 * included). Redirects are followed by hand, so every hop is checked against
 * the whitelist and robots.txt, and takes the crawl slot of its host, before
 * it is requested. A host whose slot this call already holds is not claimed
 * again: the claim of the first request would make it wait for itself.
 */
export async function fetchPage(
  env: Pick<PipelineEnv, "DB">,
  url: string,
  now: number,
  domains: readonly string[],
  deps: LadderDeps,
): Promise<PageResult> {
  let target = url;
  const held = new Set<string>();
  for (let hop = 0; ; hop++) {
    let next: URL;
    try {
      next = new URL(target);
    } catch {
      return FAILED;
    }
    if (hop === 0) {
      held.add(next.host);
    } else {
      if (next.protocol !== "https:" && next.protocol !== "http:") {
        return BLOCKED;
      }
      if (!hostAllowed(next.hostname, domains)) return BLOCKED;
      const robots = await checkRobots(env, target, now, deps.fetch, domains);
      if (!robots.allowed) return BLOCKED;
      if (!held.has(next.host)) {
        // Deferred: the message comes back later and starts again from the
        // article URL, so the hops before this one are fetched again.
        const slot = await claimHostSlot(
          env,
          next.host,
          robots.crawlDelaySec ?? 0,
          now,
        );
        if (!slot.claimed) {
          return { kind: "deferred", delaySeconds: slot.waitSec };
        }
        held.add(next.host);
      }
    }
    let page;
    try {
      page = await fetchLimited(
        target,
        {
          headers: { Accept: PAGE_ACCEPT },
          redirect: "manual",
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        },
        MAX_BODY_BYTES,
        deps.fetch,
      );
    } catch {
      return FAILED;
    }
    const { res, bytes, truncated } = page;
    const location = res.headers.get("Location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) return FAILED;
      try {
        target = new URL(location, target).href;
      } catch {
        return FAILED;
      }
      continue;
    }
    if (!res.ok) return FAILED;
    const type = (res.headers.get("Content-Type") ?? "").toLowerCase();
    let markdown: string | null;
    let rung: Rung;
    if (type.startsWith("text/markdown")) {
      markdown = new TextDecoder().decode(bytes);
      rung = 1;
    } else if (type.startsWith("text/html")) {
      markdown = await convert(deps, bytes, "text/html", target);
      rung = 2;
    } else if (type.startsWith("application/pdf")) {
      // A cut PDF cannot be parsed.
      if (truncated) return FAILED;
      markdown = await convert(deps, bytes, "application/pdf", target);
      rung = 2;
    } else {
      return FAILED;
    }
    return isBody(markdown)
      ? { kind: "body", body: { markdown, rung, truncated } }
      : FAILED;
  }
}

/**
 * Rung 3. A request is built only if THIRD_PARTY_READER_ENABLED is "true",
 * the source has jina_enabled = 1 and JINA_API_KEY is set; the model client
 * then requires MODEL_CALLS_ENABLED and a budget reservation on `jina`.
 */
export async function readWithJina(
  env: Pick<PipelineEnv, "THIRD_PARTY_READER_ENABLED" | "JINA_API_KEY">,
  article: LadderArticle,
  jinaEnabled: boolean,
  models: () => ModelClient,
): Promise<LadderBody | null> {
  if (!isEnabled(env, "THIRD_PARTY_READER_ENABLED") || !jinaEnabled) {
    return null;
  }
  if (!env.JINA_API_KEY) return null;
  try {
    const read = await models().readPage(article.url, article.id);
    return isBody(read.markdown)
      ? { markdown: read.markdown, rung: 3, truncated: read.truncated }
      : null;
  } catch (error) {
    // Flag off, over budget, in progress, failed: rung 3 failed.
    console.log({
      body: article.id,
      rung: 3,
      error: error instanceof Error ? error.name : String(error),
    });
    return null;
  }
}

async function convert(
  deps: LadderDeps,
  bytes: Uint8Array,
  mime: MarkdownMime,
  baseUrl: string,
): Promise<string | null> {
  try {
    return await deps.toMarkdown(bytes, mime, baseUrl);
  } catch {
    return null;
  }
}
