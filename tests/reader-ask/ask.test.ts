import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { AskMessage, GenerateMessage } from "../../src/pipeline/messages";
import {
  askAboutStoryCore,
  getStoryAnswerCore,
  type AskQueueMessage,
} from "../../src/server/reader-ask/ask";
import { ReaderAskError } from "../../src/server/reader-ask/errors";
import { READER_ASK_LIMITS } from "../../src/server/reader-ask/limits";
import { tokenHash } from "../../src/server/reader-watch/token";
import {
  resetPublication,
  seedArticle,
  seedEvent,
  seedEventArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const DAY_START = Date.UTC(2026, 9, 27);
const QUESTION = "What did the lab actually release this week?";

type AskCtx = Parameters<typeof askAboutStoryCore>[2];

let sent: AskQueueMessage[];

const ctx = (o: Partial<AskCtx> = {}): AskCtx => ({
  method: "POST",
  enabled: true,
  now: NOW,
  queue: {
    send: async (m) => {
      sent.push(m);
    },
  },
  ...o,
});

async function rejection(p: Promise<unknown>): Promise<{
  status: number;
  code: string;
}> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ReaderAskError);
  const err = e as ReaderAskError;
  return { status: err.status, code: err.code };
}

async function countQuestions(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM questions",
  ).first<{ n: number }>();
  return row!.n;
}

async function seedQuestions(
  n: number,
  origin: "admin" | "public",
  createdAt: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, status, prompt_version,
         model, created_at, origin)
       VALUES ('seeded question', 'global', 'completed', 'ask:v1', 'default',
         ?1, ?2)`,
    )
      .bind(createdAt, origin)
      .run();
  }
}

let tech: { industryId: number; sourceId: number };
let finance: { industryId: number; sourceId: number };
let eventId: number;
let approvedArticle: number;

beforeEach(async () => {
  sent = [];
  await env.DB.prepare("DELETE FROM questions").run();
  await resetPublication();
  ({ technology: tech, finance } = await seedSections());
  eventId = await seedEvent(tech.industryId, "Lab release");
  approvedArticle = await seedArticle({
    ...tech,
    title: "Lab ships model",
    url: "https://technology.example/lab",
  });
  await seedEventArticle(eventId, approvedArticle);
  await seedReview(approvedArticle, "approved");
});

describe("askAboutStoryCore", () => {
  it("refuses with 403 ask_disabled while the switch is off", async () => {
    expect(
      await rejection(
        askAboutStoryCore(
          env.DB,
          { eventId, question: QUESTION },
          ctx({ enabled: false }),
        ),
      ),
    ).toEqual({ status: 403, code: "ask_disabled" });
    expect(await countQuestions()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("keeps ASK_PUBLIC_ENABLED off in the test env", () => {
    expect(env.ASK_PUBLIC_ENABLED).toBe("false");
  });

  it("refuses a request that is not POST", async () => {
    expect(
      await rejection(
        askAboutStoryCore(
          env.DB,
          { eventId, question: QUESTION },
          ctx({ method: "GET" }),
        ),
      ),
    ).toEqual({ status: 405, code: "method_not_allowed" });
  });

  it("stores a public event question with only the token hash and enqueues it", async () => {
    const out = await askAboutStoryCore(
      env.DB,
      { eventId, question: QUESTION },
      ctx(),
    );
    expect(out.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare("SELECT * FROM questions WHERE id = ?1")
      .bind(out.questionId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      question: QUESTION,
      scope_type: "event",
      event_id: eventId,
      status: "pending",
      origin: "public",
      public_token_hash: await tokenHash(out.token),
      created_at: NOW,
    });
    expect(JSON.stringify(row)).not.toContain(out.token);
    expect(sent).toEqual([{ kind: "ask", questionId: out.questionId }]);
  });

  it("sends the real GenerateMessage shape", () => {
    expectTypeOf<AskQueueMessage>().toEqualTypeOf<AskMessage>();
    const m: GenerateMessage = {
      kind: "ask",
      questionId: 1,
    } as AskQueueMessage;
    expect(m.kind).toBe("ask");
  });

  it("refuses an unknown event with 404", async () => {
    expect(
      await rejection(
        askAboutStoryCore(
          env.DB,
          { eventId: eventId + 999, question: QUESTION },
          ctx(),
        ),
      ),
    ).toEqual({ status: 404, code: "not_found" });
  });

  it("refuses an event with no approved article with 404", async () => {
    const pendingEvent = await seedEvent(tech.industryId, "Pending only");
    const pending = await seedArticle({ ...tech, title: "Not reviewed" });
    await seedEventArticle(pendingEvent, pending);
    const rejected = await seedArticle({ ...tech, title: "Rejected" });
    await seedEventArticle(pendingEvent, rejected);
    await seedReview(rejected, "rejected");
    expect(
      await rejection(
        askAboutStoryCore(
          env.DB,
          { eventId: pendingEvent, question: QUESTION },
          ctx(),
        ),
      ),
    ).toEqual({ status: 404, code: "not_found" });
    expect(await countQuestions()).toBe(0);
  });

  it("refuses a Finance event (v1 excludes Finance)", async () => {
    const finEvent = await seedEvent(finance.industryId, "Earnings");
    const art = await seedArticle({ ...finance, title: "Q3 results" });
    await seedEventArticle(finEvent, art);
    await seedReview(art, "approved");
    expect(
      await rejection(
        askAboutStoryCore(
          env.DB,
          { eventId: finEvent, question: QUESTION },
          ctx(),
        ),
      ),
    ).toEqual({ status: 403, code: "section_not_allowed" });
    expect(await countQuestions()).toBe(0);
  });

  it("accepts the 30th public question of the UTC day", async () => {
    expect(READER_ASK_LIMITS.publicPerDay).toBe(30);
    await seedQuestions(29, "public", DAY_START);
    await askAboutStoryCore(env.DB, { eventId, question: QUESTION }, ctx());
    expect(await countQuestions()).toBe(30);
    expect(sent).toHaveLength(1);
  });

  it("refuses the 31st public question of the UTC day with 429", async () => {
    await seedQuestions(30, "public", DAY_START);
    expect(
      await rejection(
        askAboutStoryCore(env.DB, { eventId, question: QUESTION }, ctx()),
      ),
    ).toEqual({ status: 429, code: "daily_limit" });
    expect(await countQuestions()).toBe(30);
    expect(sent).toEqual([]);
  });

  it("does not count yesterday's public questions", async () => {
    await seedQuestions(30, "public", DAY_START - 1);
    await askAboutStoryCore(env.DB, { eventId, question: QUESTION }, ctx());
    expect(sent).toHaveLength(1);
  });

  it("does not count admin questions", async () => {
    await seedQuestions(30, "admin", DAY_START);
    await askAboutStoryCore(env.DB, { eventId, question: QUESTION }, ctx());
    expect(sent).toHaveLength(1);
  });
});

describe("getStoryAnswerCore", () => {
  const read = (questionId: number, token: string) =>
    getStoryAnswerCore(env.DB, { questionId, token }, { method: "POST" });

  async function ask(): Promise<{ questionId: number; token: string }> {
    return askAboutStoryCore(env.DB, { eventId, question: QUESTION }, ctx());
  }

  async function complete(
    questionId: number,
    o: { citations: unknown[]; refusal?: 0 | 1; unverified?: string[] },
  ): Promise<void> {
    await env.DB.prepare(
      `UPDATE questions SET status = 'completed', answer = ?2, citations = ?3,
         unverified = ?4, refusal = ?5, cost_micros = 4321,
         model = 'secret-model-name', error_message = 'secret-error',
         supplemental_fetched = '[{"url":"https://secret.example/x"}]',
         prompt_version = 'ask:v9', completed_at = ?6
       WHERE id = ?1`,
    )
      .bind(
        questionId,
        "The lab released a model.",
        JSON.stringify(o.citations),
        JSON.stringify(o.unverified ?? ["Release date"]),
        o.refusal ?? 0,
        NOW + 1000,
      )
      .run();
  }

  const citation = (articleId: number, verified: boolean, quote: string) => ({
    articleId,
    bodySha: "sha-current",
    quote,
    claim: `claim for ${quote}`,
    startOffset: 0,
    endOffset: quote.length,
    verified,
    isPrimarySource: false,
  });

  it("returns only the reader fields, with verified approved citations", async () => {
    const { questionId, token } = await ask();
    const unapproved = await seedArticle({ ...tech, title: "Unreviewed" });
    await seedEventArticle(eventId, unapproved);
    await complete(questionId, {
      citations: [
        citation(approvedArticle, true, "verified quote"),
        citation(approvedArticle, false, "unverified quote"),
        citation(unapproved, true, "quote from unapproved"),
        citation(900001, true, "supplemental quote"),
      ],
    });
    const out = await read(questionId, token);
    expect(Object.keys(out).sort()).toEqual(
      ["answer", "citations", "refusal", "status", "unverified"].sort(),
    );
    expect(out).toMatchObject({
      status: "completed",
      refusal: false,
      answer: "The lab released a model.",
      unverified: ["Release date"],
    });
    expect(out.citations).toHaveLength(1);
    expect(Object.keys(out.citations[0]).sort()).toEqual(
      ["claim", "href", "quote", "sourceName", "title", "url"].sort(),
    );
    expect(out.citations[0]).toEqual({
      quote: "verified quote",
      claim: "claim for verified quote",
      title: "Lab ships model",
      sourceName: "Technology Wire",
      url: "https://technology.example/lab",
      href: `/a/${approvedArticle}`,
    });
    const json = JSON.stringify(out);
    for (const secret of [
      "secret-model-name",
      "secret-error",
      "secret.example",
      "4321",
      "ask:v9",
      await tokenHash(token),
      "sha-current",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("drops a citation of an approved article from another event", async () => {
    const otherEvent = await seedEvent(tech.industryId, "Other story");
    const other = await seedArticle({
      ...tech,
      title: "Other story article",
      url: "https://technology.example/other",
    });
    await seedEventArticle(otherEvent, other);
    await seedReview(other, "approved");
    const { questionId, token } = await ask();
    await complete(questionId, {
      citations: [citation(other, true, "quote from another event")],
    });
    const out = await read(questionId, token);
    expect(out.status).toBe("completed");
    expect(out.citations).toEqual([]);
  });

  it("returns no url for an article link that is not http/https", async () => {
    const bad = await seedArticle({
      ...tech,
      title: "Bad link",
      url: "javascript:alert(1)",
    });
    await seedEventArticle(eventId, bad);
    await seedReview(bad, "approved");
    const { questionId, token } = await ask();
    await complete(questionId, { citations: [citation(bad, true, "q")] });
    const out = await read(questionId, token);
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0].url).toBeNull();
    expect(out.citations[0].href).toBe(`/a/${bad}`);
  });

  it("hides the model answer of a refusal", async () => {
    const { questionId, token } = await ask();
    await complete(questionId, { citations: [], refusal: 1 });
    const out = await read(questionId, token);
    expect(out.refusal).toBe(true);
    expect(out.answer).toBeNull();
    expect(out.unverified).toEqual(["Release date"]);
  });

  it("reports a pending question without an answer", async () => {
    const { questionId, token } = await ask();
    expect(await read(questionId, token)).toEqual({
      status: "pending",
      refusal: false,
      answer: null,
      citations: [],
      unverified: [],
    });
  });

  it("returns 404 for a wrong token", async () => {
    const { questionId } = await ask();
    expect(await rejection(read(questionId, "B".repeat(43)))).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(await rejection(read(questionId, "short"))).toEqual({
      status: 404,
      code: "not_found",
    });
  });

  it("returns 404 for an admin question even with a matching hash", async () => {
    const token = "C".repeat(43);
    const row = await env.DB.prepare(
      `INSERT INTO questions (question, scope_type, event_id, status,
         prompt_version, model, created_at, origin, public_token_hash)
       VALUES ('admin question', 'event', ?1, 'completed', 'ask:v1',
         'default', ?2, 'admin', ?3) RETURNING id`,
    )
      .bind(eventId, NOW, await tokenHash(token))
      .first<{ id: number }>();
    expect(await rejection(read(row!.id, token))).toEqual({
      status: 404,
      code: "not_found",
    });
  });

  it("refuses a request that is not POST", async () => {
    const { questionId, token } = await ask();
    expect(
      await rejection(
        getStoryAnswerCore(env.DB, { questionId, token }, { method: "GET" }),
      ),
    ).toEqual({ status: 405, code: "method_not_allowed" });
  });
});
