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

/** True for a system placeholder source, which is never collected. */
export function isSystemSource(feedUrl: string): boolean {
  return feedUrl.startsWith("system:");
}

/** Source name a reader sees: a system source shows the document's host. */
export function readerSourceName(
  name: string,
  feedUrl: string,
  canonicalUrl: string,
): string {
  return isSystemSource(feedUrl) ? documentHost(canonicalUrl) : name;
}
