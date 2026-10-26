// robots.txt per host, cached in D1 `fetch_hosts` for 24 hours (1 hour after
// a failed request), the per-host crawl slot (Crawl-delay), and the host
// whitelist. Matching rules: src/lib/robots.ts.
import { fetchLimited } from "../../lib/http";
import { robotsFromResponse } from "../../lib/robots";
import type { Robots } from "../../lib/robots";
import type { PipelineEnv } from "../messages";

/** Product token in USER_AGENT (src/lib/http.ts). */
export const ROBOTS_UA_TOKEN = "DailyBot";
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
/** After a network error or 5xx: ask again after this time. */
export const ROBOTS_FAIL_TTL_MS = 60 * 60 * 1000;
/** RFC 9309 §2.5: parse at least 500 KiB. */
export const ROBOTS_MAX_BYTES = 512 * 1024;
export const ROBOTS_TIMEOUT_MS = 30_000;
/** For page fetches and robots.txt requests alike. */
export const MAX_REDIRECTS = 5;

/** `host === d || host.endsWith("." + d)` for any domain `d`. */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((raw) => {
    const d = raw.trim().toLowerCase();
    return d !== "" && (h === d || h.endsWith(`.${d}`));
  });
}

export interface RobotsCheck {
  allowed: boolean;
  crawlDelaySec: number | null;
}

interface HostRow {
  robots_status: number;
  robots_body: string | null;
  robots_fetched_at: number;
}

/**
 * Whether `url` may be fetched. Reads the cached robots.txt of the host, or
 * fetches it (and stores it) when there is none younger than 24 hours.
 * Redirects of the robots.txt request must stay in `domains`. After this
 * call the host has a `fetch_hosts` row, which claimHostSlot needs.
 *
 * A failed request (network error, 5xx, 429, a bad redirect) keeps a stored
 * response and asks again in an hour; with none stored the failure itself
 * is stored for an hour (disallow all, RFC 9309 §2.3.1.4).
 */
export async function checkRobots(
  env: Pick<PipelineEnv, "DB">,
  url: string,
  now: number,
  fetchFn: typeof fetch,
  domains: readonly string[],
): Promise<RobotsCheck> {
  const target = new URL(url);
  const host = target.host;
  let row = await env.DB.prepare(
    `SELECT robots_status, robots_body, robots_fetched_at FROM fetch_hosts
     WHERE host = ?1`,
  )
    .bind(host)
    .first<HostRow>();
  if (!row || row.robots_fetched_at <= now - ROBOTS_TTL_MS) {
    const fetched = await fetchRobots(target, domains, fetchFn);
    // Backdated, so the row is stale again after ROBOTS_FAIL_TTL_MS.
    const retry = now - (ROBOTS_TTL_MS - ROBOTS_FAIL_TTL_MS);
    if (unreachable(fetched.robots_status) && row) {
      row = { ...row, robots_fetched_at: retry };
      await env.DB.prepare(
        "UPDATE fetch_hosts SET robots_fetched_at = ?2 WHERE host = ?1",
      )
        .bind(host, retry)
        .run();
    } else {
      row = {
        ...fetched,
        robots_fetched_at: unreachable(fetched.robots_status) ? retry : now,
      };
      await env.DB.prepare(
        `INSERT INTO fetch_hosts (host, robots_status, robots_body,
         robots_fetched_at, crawl_delay_s)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (host) DO UPDATE SET robots_status = excluded.robots_status,
         robots_body = excluded.robots_body,
         robots_fetched_at = excluded.robots_fetched_at,
         crawl_delay_s = excluded.crawl_delay_s`,
      )
        .bind(
          host,
          row.robots_status,
          row.robots_body,
          row.robots_fetched_at,
          interpret(row).crawlDelaySec,
        )
        .run();
    }
  }
  const robots = interpret(row);
  return {
    allowed: robots.allowed(target.pathname + target.search),
    crawlDelaySec: robots.crawlDelaySec,
  };
}

/** robotsFromResponse's "unreachable" (disallow all): not 2xx or 4xx. */
function unreachable(status: number): boolean {
  return (
    !(status >= 200 && status < 300) &&
    !(status >= 400 && status < 500 && status !== 429)
  );
}

/**
 * GET /robots.txt. Redirects are followed by hand, up to MAX_REDIRECTS, and
 * only to http(s) hosts in `domains`; anything else is status 0.
 */
async function fetchRobots(
  target: URL,
  domains: readonly string[],
  fetchFn: typeof fetch,
): Promise<Omit<HostRow, "robots_fetched_at">> {
  const failed = { robots_status: 0, robots_body: null };
  try {
    let url = `${target.origin}/robots.txt`;
    for (let hop = 0; ; hop++) {
      const { res, bytes } = await fetchLimited(
        url,
        { redirect: "manual", signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS) },
        ROBOTS_MAX_BYTES,
        fetchFn,
      );
      const location = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) return failed;
        const next = new URL(location, url);
        if (next.protocol !== "https:" && next.protocol !== "http:") {
          return failed;
        }
        if (!hostAllowed(next.hostname, domains)) return failed;
        url = next.href;
        continue;
      }
      const ok = res.status >= 200 && res.status < 300;
      return {
        robots_status: res.status,
        robots_body: ok ? new TextDecoder().decode(bytes) : null,
      };
    }
  } catch {
    // Network error, timeout or a bad Location.
    return failed;
  }
}

function interpret(row: Omit<HostRow, "robots_fetched_at">): Robots {
  return robotsFromResponse(
    row.robots_status,
    row.robots_body,
    ROBOTS_UA_TOKEN,
  );
}

export type HostSlot = { claimed: true } | { claimed: false; waitSec: number };

/**
 * Takes the host's next request slot: claimed if no request is due to wait,
 * and then the next one waits `delaySec`. One conditional UPDATE, so two
 * consumers cannot both take it. Otherwise `waitSec` is the time left until
 * the slot is free (at least 1). The row must exist (checkRobots).
 */
export async function claimHostSlot(
  env: Pick<PipelineEnv, "DB">,
  host: string,
  delaySec: number,
  now: number,
): Promise<HostSlot> {
  const result = await env.DB.prepare(
    `UPDATE fetch_hosts SET next_allowed_at = ?2 WHERE host = ?1
       AND (next_allowed_at IS NULL OR next_allowed_at <= ?3)`,
  )
    .bind(host, now + delaySec * 1000, now)
    .run();
  if (result.meta.changes === 1) return { claimed: true };
  const row = await env.DB.prepare(
    "SELECT next_allowed_at FROM fetch_hosts WHERE host = ?1",
  )
    .bind(host)
    .first<{ next_allowed_at: number | null }>();
  const left = (row?.next_allowed_at ?? now) - now;
  return { claimed: false, waitSec: Math.max(1, Math.ceil(left / 1000)) };
}
