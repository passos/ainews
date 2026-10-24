// URL normalization for de-duplication. The result is only compared, never
// fetched: fetches use the original URL (some sites need `www.` or `http`).

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "_hsenc",
  "_hsmi",
  "igshid",
  "mkt_tok",
  "spm",
]);

/** Canonical form of an http(s) URL, or null for anything else. */
export function normalizeUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.protocol = "https:";
  if (url.port === "80" || url.port === "443") url.port = "";
  url.hostname = url.hostname.replace(/^www\./, "");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

/**
 * The URL as given if it is http(s), else null. For links that come from
 * sources: a `javascript:` or `data:` URL must never become an href.
 */
export function safeHttpUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? input.trim()
      : null;
  } catch {
    return null;
  }
}
