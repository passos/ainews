// Outbound HTTP for collection and body fetching (#5, #6).

/**
 * Sent on every outbound request. It must not contain a crawler name that
 * sites block by name (ClaudeBot, anthropic-ai, CCBot, ChatGPT-User).
 */
export const USER_AGENT = "PersonalNewsBot/1.0 (+https://news.ioenv.com)";

export interface LimitedResponse {
  res: Response;
  /** At most `maxBytes` bytes of the body. */
  bytes: Uint8Array;
  /** True if the body was longer than `maxBytes`; reading stopped there. */
  truncated: boolean;
}

/**
 * fetch() with USER_AGENT (unless `init` sets one) that reads at most
 * `maxBytes` of the body. `fetchFn` is passed in so tests use a fake.
 */
export async function fetchLimited(
  url: string,
  init: RequestInit,
  maxBytes: number,
  fetchFn: typeof fetch,
): Promise<LimitedResponse> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
  const res = await fetchFn(url, { ...init, headers });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { res, bytes, truncated };
}
