// robots.txt parsing and matching (RFC 9309). Pure: fetching and caching are
// in src/pipeline/body/robots.ts.
//
// - Group: the groups whose user-agent equals our product token (case
//   insensitive) are merged; if there is none, the `*` groups (§2.2.1).
// - Rule: the longest matching path pattern wins; on a tie, Allow wins; no
//   match allows (§2.2.2). `*` matches any sequence, a final `$` anchors the
//   end (§2.2.3). /robots.txt is always allowed (§2.2.2).
// - Crawl-delay is not in RFC 9309; it is read from the chosen group.

export interface Robots {
  /** `pathAndQuery`: URL.pathname + URL.search, as in the request. */
  allowed(pathAndQuery: string): boolean;
  /** Seconds, rounded up; null if the group has none. */
  crawlDelaySec: number | null;
}

interface Rule {
  allow: boolean;
  /** Pattern length in octets, after percent-encoding. */
  length: number;
  regex: RegExp;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay: number | null;
}

export const ALLOW_ALL: Robots = { allowed: () => true, crawlDelaySec: null };
export const DISALLOW_ALL: Robots = {
  allowed: (path) => path === "/robots.txt",
  crawlDelaySec: null,
};

/**
 * The rules for a robots.txt response (§2.3.1): 2xx -> parse the body;
 * 4xx -> allow all; 5xx, network error (status 0) and anything else ->
 * disallow all. 429 counts as unreachable, not as "unavailable".
 */
export function robotsFromResponse(
  status: number,
  body: string | null,
  uaToken: string,
): Robots {
  if (status >= 200 && status < 300) return parseRobots(body ?? "", uaToken);
  if (status >= 400 && status < 500 && status !== 429) return ALLOW_ALL;
  return DISALLOW_ALL;
}

export function parseRobots(txt: string, uaToken: string): Robots {
  const groups: Group[] = [];
  let current: Group | null = null;
  // A user-agent line after rules starts a new group.
  let inAgents = false;
  for (const raw of (txt.startsWith("\uFEFF") ? txt.slice(1) : txt).split(
    /\r\n|\r|\n/,
  )) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!inAgents || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        inAgents = true;
      }
      current.agents.push(productToken(value));
      continue;
    }
    if (!current) continue; // Rules before any user-agent line.
    if (key === "allow" || key === "disallow") {
      inAgents = false;
      // An empty Disallow allows everything: it is no rule.
      if (value === "") continue;
      const pattern = encodePattern(value);
      current.rules.push({
        allow: key === "allow",
        length: pattern.length,
        regex: patternRegex(pattern),
      });
    } else if (key === "crawl-delay") {
      inAgents = false;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) current.crawlDelay = Math.ceil(n);
    } else {
      // Sitemap and other records do not end the user-agent lines.
    }
  }

  const token = uaToken.toLowerCase();
  let chosen = groups.filter((g) => g.agents.includes(token));
  if (chosen.length === 0)
    chosen = groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const delays = chosen
    .map((g) => g.crawlDelay)
    .filter((d): d is number => d !== null);

  return {
    allowed(pathAndQuery) {
      if (pathAndQuery === "/robots.txt") return true;
      const path = encodePattern(pathAndQuery);
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.regex.test(path)) continue;
        if (
          !best ||
          rule.length > best.length ||
          (rule.length === best.length && rule.allow && !best.allow)
        ) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
    crawlDelaySec: delays.length > 0 ? Math.max(...delays) : null,
  };
}

/** "PersonalNewsBot/1.0" -> "personalnewsbot"; "*" stays. */
function productToken(value: string): string {
  return (value.split(/[\s/]/)[0] ?? "").toLowerCase();
}

/**
 * Normal form of a URL path or a pattern, so the two compare the same way
 * (§2.2.2): an escape of an unreserved character (A-Z a-z 0-9 - . _ ~) is
 * decoded, every other escape is made upper case, and non-ASCII characters
 * are percent-encoded as UTF-8.
 */
function encodePattern(value: string): string {
  return value
    .replace(/%([0-9a-f]{2})/gi, (m, hex: string) => {
      const c = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(c) ? c : m.toUpperCase();
    })
    .replace(/[\u0080-\uFFFF]+/g, (m) => encodeURIComponent(m));
}

function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}
