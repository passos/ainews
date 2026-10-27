import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AskStoryView } from "../src/components/AskStoryCard";
import {
  ASK_COPY,
  ASK_POLL,
  askErrorMessage,
  pollAnswer,
  submitAsk,
  type AskState,
} from "../src/lib/ask";
import type { StoryAnswer } from "../src/server/reader-ask/ask";

const ANSWER: StoryAnswer = {
  status: "completed",
  refusal: false,
  answer: "The lab <b>released</b> a model.",
  citations: [
    {
      quote: "We are releasing the model today.",
      claim: "The model shipped.",
      title: "Lab ships model",
      sourceName: "Technology Wire",
      url: "https://technology.example/lab",
      href: "/a/5",
    },
    {
      quote: "Second quote.",
      claim: "Another claim.",
      title: "No link",
      sourceName: "Wire",
      url: null,
      href: "/a/6",
    },
  ],
  unverified: ["Release date"],
};

const view = (state: AskState) =>
  renderToStaticMarkup(
    createElement(AskStoryView, {
      state,
      pending: false,
      onSubmit: () => {},
    }),
  );

const errorResponse = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("ASK_POLL", () => {
  it("polls every 3 s for at most 120 s", () => {
    expect(ASK_POLL).toEqual({ intervalMs: 3000, maxMs: 120_000 });
  });
});

describe("submitAsk", () => {
  it("sends the normalised question and returns the handle", async () => {
    const calls: unknown[] = [];
    const out = await submitAsk(
      7,
      "  What   shipped this week?  ",
      async (input) => {
        calls.push(input);
        return { questionId: 3, token: "tok" };
      },
    );
    expect(calls).toEqual([
      { eventId: 7, question: "What shipped this week?" },
    ]);
    expect(out).toEqual({ kind: "ok", questionId: 3, token: "tok" });
  });

  it("does not call the server for a too short question", async () => {
    let called = false;
    const out = await submitAsk(7, "short", async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false);
    expect(out.kind).toBe("error");
  });

  it("maps 429 daily_limit to the limit message", async () => {
    const out = await submitAsk(7, "What shipped this week?", async () => {
      throw errorResponse(429, "daily_limit");
    });
    expect(out).toEqual({ kind: "error", message: ASK_COPY.dailyLimit });
    expect(ASK_COPY.dailyLimit).toBe(
      "Today's question limit has been reached.",
    );
  });

  it("maps unknown failures to a generic message", () => {
    expect(askErrorMessage(null)).toMatch(/try again/i);
  });
});

describe("pollAnswer", () => {
  it("stops when the question is completed", async () => {
    const statuses = ["pending", "processing", "completed"];
    let polls = 0;
    let slept = 0;
    const out = await pollAnswer(
      async () => ({ ...ANSWER, status: statuses[polls++] }),
      { sleep: async (ms) => void (slept += ms) },
    );
    expect(out).toEqual({ kind: "done", answer: { ...ANSWER } });
    expect(polls).toBe(3);
    expect(slept).toBe(9000);
  });

  it("gives up after 120 s (40 polls)", async () => {
    let polls = 0;
    const out = await pollAnswer(
      async () => {
        polls++;
        return { ...ANSWER, status: "pending" };
      },
      { sleep: async () => {} },
    );
    expect(out).toEqual({ kind: "timeout" });
    expect(polls).toBe(40);
  });

  it("reports a 404 as an error", async () => {
    const out = await pollAnswer(
      async () => {
        throw errorResponse(404, "not_found");
      },
      { sleep: async () => {} },
    );
    expect(out.kind).toBe("error");
  });
});

describe("AskStoryView", () => {
  it("shows the form with a POST method", () => {
    const html = view({ kind: "idle" });
    expect(html).toContain("Ask about this story");
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html).toContain('name="question"');
  });

  it("shows the researching line while waiting", () => {
    expect(view({ kind: "waiting" })).toContain(
      "Researching approved sources…",
    );
  });

  it("renders the answer as text, then verified quotes, then could not verify", () => {
    const html = view({ kind: "done", answer: ANSWER });
    const label = html.indexOf("Model answer · not editor-reviewed");
    const note = html.indexOf("Check it against the quoted sources below.");
    const verified = html.indexOf("Verified quotes");
    const unverified = html.indexOf("Could not verify");
    expect(label).toBeGreaterThanOrEqual(0);
    expect(note).toBeGreaterThan(label);
    expect(verified).toBeGreaterThan(note);
    expect(unverified).toBeGreaterThan(verified);
    // Model text is escaped, never HTML.
    expect(html).toContain("The lab &lt;b&gt;released&lt;/b&gt; a model.");
    expect(html).not.toContain("<b>released</b>");
    expect(html).toContain("We are releasing the model today.");
    expect(html).toContain('href="https://technology.example/lab"');
    expect(html).toContain('href="/a/5"');
    expect(html).toContain('href="/a/6"');
    expect(html).toContain("Release date");
  });

  it("shows the refusal line and no answer label for a refusal", () => {
    const html = view({
      kind: "done",
      answer: { ...ANSWER, refusal: true, answer: null, citations: [] },
    });
    expect(html).toContain("We could not answer this from approved sources.");
    expect(html).not.toContain("Model answer");
    expect(html).not.toContain("Check it against the quoted sources below.");
    expect(html).toContain("Release date");
  });

  it("shows an error message", () => {
    expect(view({ kind: "error", message: ASK_COPY.dailyLimit })).toContain(
      "Today&#x27;s question limit has been reached.",
    );
  });
});
