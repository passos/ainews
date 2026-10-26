/**
 * Source attribution for system placeholder sources (feed_url 'system:…',
 * e.g. the per-section primary-documents source). Such a source names nothing
 * a reader knows, so readers see the document's own host instead.
 */

/** Lower-case host of `url` without "www."; "unknown" when there is none. */
export function documentHost(url: string): string {
  try {
    return (
      new URL(url).hostname.toLowerCase().replace(/^www\./, "") || "unknown"
    );
  } catch {
    return "unknown";
  }
}

/**
 * True for a system placeholder source, which is never collected. Ignores
 * case, like SQL `feed_url LIKE 'system:%'`, and leading/trailing whitespace.
 */
export function isSystemSource(feedUrl: string): boolean {
  return feedUrl.trim().toLowerCase().startsWith("system:");
}

/** Source name a reader sees: a system source shows the document's host. */
export function readerSourceName(
  name: string,
  feedUrl: string,
  canonicalUrl: string,
): string {
  return isSystemSource(feedUrl) ? documentHost(canonicalUrl) : name;
}

/**
 * Source name and domain for a pipeline consumer. The domain falls back to
 * the document host when the source has none or is a system source; the name
 * changes only for a system source (a real source keeps its own name).
 */
export function attributeSource(s: {
  name: string;
  siteDomain: string | null;
  feedUrl: string;
  canonicalUrl: string;
}): { name: string; domain: string } {
  const system = isSystemSource(s.feedUrl);
  const host = () => documentHost(s.canonicalUrl);
  return {
    name: system ? host() : s.name,
    domain: system || !s.siteDomain ? host() : s.siteDomain,
  };
}
