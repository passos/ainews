// Jina Reader: fetch ladder rung 3 (#6). Runtime code reaches it only
// through the model client's `read` slot (models.ts readPage), so the
// ledger, the budget reservation and MODEL_CALLS_ENABLED apply. Nothing here
// touches the ledger or the budget.
//
// Assumption (from AIHOT packages/backend/src/providers/jina.ts; checked by
// scripts/smoke-body.ts): the request headers below, the
// "\nMarkdown Content:\n" separator (LF or CRLF) and the `x-usage-tokens` header.
//
// Node-loadable (scripts/smoke-body.ts): imports use explicit extensions and
// the imported files have no runtime imports.
import { fetchLimited } from "../lib/http.ts";
import { TransportHttpError } from "./transport.ts";
import type { ModelTransport } from "./transport.ts";

export const JINA_ENDPOINT = "https://r.jina.ai/";
export const JINA_TIMEOUT_MS = 60_000;
/**
 * The ledger stores the whole response as llm_calls.response_json, and a D1
 * row holds at most 2,000,000 bytes (D1 limits page; not checked here). JSON
 * escaping makes the text longer, so the cap is half of that.
 */
export const JINA_MAX_BYTES = 1_000_000;

/** Input of the `read` slot. */
export interface JinaInput {
  url: string;
}

/** What the transport returns; the ledger stores it as response_json. */
export interface JinaRaw {
  text: string;
  /** `x-usage-tokens`; null if the header is missing or not an integer. */
  usageTokens: number | null;
  truncated: boolean;
}

export function jinaTransport(options: {
  apiKey: string;
  fetch?: typeof fetch;
}): ModelTransport {
  if (!options.apiKey) throw new Error("jinaTransport: apiKey is empty");
  const send = options.fetch ?? fetch;
  return {
    async run(_model, input) {
      const { url } = input as JinaInput;
      const { res, bytes, truncated } = await fetchLimited(
        `${JINA_ENDPOINT}${url}`,
        {
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "X-Return-Format": "markdown",
            Accept: "text/plain",
          },
          signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
        },
        JINA_MAX_BYTES,
        send,
      );
      const text = new TextDecoder().decode(bytes);
      if (!res.ok)
        throw new TransportHttpError(res.status, text.slice(0, 2000));
      const header = res.headers.get("x-usage-tokens");
      const tokens = header === null ? NaN : Number(header);
      const raw: JinaRaw = {
        text,
        usageTokens:
          Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null,
        truncated,
      };
      return raw;
    },
  };
}

const MARKER = /\r?\nMarkdown Content:\r?\n/;
/** Head of a response without the marker that is checked for errors. */
const HEAD_CHARS = 1_000;
const PAGE_ERROR = /Target URL returned error [45]\d\d|CAPTCHA/i;

/**
 * The page markdown: the part after "Markdown Content:". Null if the head
 * says the target page failed (HTTP 4xx/5xx or a CAPTCHA).
 */
export function parseJinaText(text: string): string | null {
  const marker = MARKER.exec(text);
  const head = marker ? text.slice(0, marker.index) : text.slice(0, HEAD_CHARS);
  if (PAGE_ERROR.test(head)) return null;
  return marker ? text.slice(marker.index + marker[0].length) : text;
}
