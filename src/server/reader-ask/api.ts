// Server functions for "Ask about this story" (#133). Every server function
// here is POST (tests/architecture.test.ts, R5): the answer read carries the
// token in the body, not the URL. The edge (src/server/edge.ts) checks
// Origin and the body size before parsing.
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { isEnabled } from "../../lib/flags";
import { askAboutStoryCore, getStoryAnswerCore } from "./ask";
import { ReaderAskError } from "./errors";
import { parseAnswerInput, parseAskInput } from "./input";

// Loaded on call, not at the top: the event route imports this file, and a
// static import of the server entry would pull TanStack's virtual modules
// into every test that imports that route.
async function requestMethod(): Promise<string> {
  const { getRequest } = await import("@tanstack/react-start/server");
  return getRequest().method;
}

function jsonError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A ReaderAskError becomes a JSON error response with its status. Any other
// error (D1, queue) becomes a plain 500: its message can carry SQL or table
// names. Only the error is logged, never the question, token or hashes.
export function toResponse(error: unknown): Response {
  if (error instanceof ReaderAskError) {
    return jsonError(error.code, error.status);
  }
  console.error("reader-ask internal error", error);
  return jsonError("internal", 500);
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

export const askAboutStory = createServerFn({ method: "POST" })
  .validator(validate(parseAskInput))
  .handler(async ({ data }) => {
    const method = await requestMethod();
    try {
      return await askAboutStoryCore(env.DB, data, {
        method,
        enabled: isEnabled(env, "ASK_PUBLIC_ENABLED"),
        now: Date.now(),
        queue: env.Q_GENERATE,
      });
    } catch (error) {
      throw toResponse(error);
    }
  });

export const getStoryAnswer = createServerFn({ method: "POST" })
  .validator(validate(parseAnswerInput))
  .handler(async ({ data }) => {
    const method = await requestMethod();
    try {
      return await getStoryAnswerCore(env.DB, data, {
        method,
      });
    } catch (error) {
      throw toResponse(error);
    }
  });
