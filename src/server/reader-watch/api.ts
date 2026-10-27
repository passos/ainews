// Server functions for the public write entries (architecture §3 "公开写入口").
// Every server function here is POST (tests/architecture.test.ts, R5). The
// edge (src/server/edge.ts) checks Origin and the body size before parsing.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { isEnabled } from "../../lib/flags";
import {
  createReaderWatchCore,
  ReaderWatchError,
  revokeReaderWatchCore,
} from "./create";
import { parseReaderWatchInput, parseRevokeInput } from "./input";

// IP_HASH_SALT is a secret, so it is not in worker-configuration.d.ts.
type ReaderWatchEnv = {
  DB: D1Database;
  SITE_URL: string;
  READER_WATCH_ENABLED?: string;
  IP_HASH_SALT?: string;
};

// A ReaderWatchError becomes a JSON error response with its status.
function toResponse(error: unknown): unknown {
  if (!(error instanceof ReaderWatchError)) return error;
  return new Response(JSON.stringify({ error: error.code }), {
    status: error.status,
    headers: { "Content-Type": "application/json" },
  });
}

function validate<T>(parse: (raw: unknown) => T) {
  return (raw: unknown): T => {
    try {
      return parse(raw);
    } catch (error) {
      throw toResponse(error);
    }
  };
}

export const createReaderWatch = createServerFn({ method: "POST" })
  .validator(validate(parseReaderWatchInput))
  .handler(async ({ data }) => {
    const request = getRequest();
    const e = env as unknown as ReaderWatchEnv;
    try {
      return await createReaderWatchCore(e.DB, data, {
        method: request.method,
        ip: request.headers.get("cf-connecting-ip"),
        salt: e.IP_HASH_SALT,
        enabled: isEnabled(e, "READER_WATCH_ENABLED"),
        now: Date.now(),
        siteUrl: e.SITE_URL,
      });
    } catch (error) {
      throw toResponse(error);
    }
  });

export const revokeReaderWatch = createServerFn({ method: "POST" })
  .validator(validate(parseRevokeInput))
  .handler(async ({ data }) => {
    const request = getRequest();
    const e = env as unknown as ReaderWatchEnv;
    try {
      await revokeReaderWatchCore(e.DB, data, {
        method: request.method,
        now: Date.now(),
      });
      return { ok: true };
    } catch (error) {
      throw toResponse(error);
    }
  });
