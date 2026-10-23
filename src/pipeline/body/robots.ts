// robots.txt per host, cached in D1 `fetch_hosts` for 24 hours, and the
// per-host crawl slot (Crawl-delay). Matching rules: src/lib/robots.ts.
import { fetchLimited } from "../../lib/http";
import { robotsFromResponse } from "../../lib/robots";
import type { Robots } from "../../lib/robots";
import type { PipelineEnv } from "../messages";

/** Product token in USER_AGENT (src/lib/http.ts). */
export const ROBOTS_UA_TOKEN = "PersonalNewsBot";
export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
/** RFC 9309 §2.5: parse at least 500 KiB. */
export const ROBOTS_MAX_BYTES = 512 * 1024;
export const ROBOTS_TIMEOUT_MS = 30_000;

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
 * fetches it (and stores it) when there is none younger than 24 hours. After
 * this call the host has a `fetch_hosts` row, which claimHostSlot needs.
 */
export async function checkRobots(
  env: Pick<PipelineEnv, "DB">,
  url: string,
  now: number,
  fetchFn: typeof fetch,
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
    const fetched = await fetchRobots(target, fetchFn);
    row = { ...fetched, robots_fetched_at: now };
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
        now,
        interpret(row).crawlDelaySec,
      )
      .run();
  }
  const robots = interpret(row);
  return {
    allowed: robots.allowed(target.pathname + target.search),
    crawlDelaySec: robots.crawlDelaySec,
  };
}

async function fetchRobots(
  target: URL,
  fetchFn: typeof fetch,
): Promise<Omit<HostRow, "robots_fetched_at">> {
  try {
    const { res, bytes } = await fetchLimited(
      `${target.origin}/robots.txt`,
      { signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS) },
      ROBOTS_MAX_BYTES,
      fetchFn,
    );
    const ok = res.status >= 200 && res.status < 300;
    return {
      robots_status: res.status,
      robots_body: ok ? new TextDecoder().decode(bytes) : null,
    };
  } catch {
    return { robots_status: 0, robots_body: null };
  }
}

function interpret(row: Omit<HostRow, "robots_fetched_at">): Robots {
  return robotsFromResponse(
    row.robots_status,
    row.robots_body,
    ROBOTS_UA_TOKEN,
  );
}

/**
 * Takes the host's next request slot: true if no request is due to wait,
 * and then the next one waits `delaySec`. One conditional UPDATE, so two
 * consumers cannot both take it. The row must exist (checkRobots).
 */
export async function claimHostSlot(
  env: Pick<PipelineEnv, "DB">,
  host: string,
  delaySec: number,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE fetch_hosts SET next_allowed_at = ?2 WHERE host = ?1
       AND (next_allowed_at IS NULL OR next_allowed_at <= ?3)`,
  )
    .bind(host, now + delaySec * 1000, now)
    .run();
  return result.meta.changes === 1;
}
