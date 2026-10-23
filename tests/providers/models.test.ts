import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ModelCallsDisabledError,
  createModelClient,
} from "../../src/providers/models";
import { TransportHttpError } from "../../src/providers/transport";
import { jevResponse } from "./fixtures";
import {
  ENABLED,
  NOW,
  budgetRow,
  fakeTransport,
  ledgerRow,
  resetLedger,
} from "./fakes";

const REQUEST = { system: "s", prompt: "p", maxOutputTokens: 16 };

async function ledgerCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM llm_calls",
  ).first<{ n: number }>();
  return row?.n ?? -1;
}

describe("model client", () => {
  beforeEach(() => resetLedger());

  it.each([
    ["unset", {}],
    ["false", { MODEL_CALLS_ENABLED: "false" }],
  ])(
    "sends nothing and writes nothing when the flag is %s",
    async (_, flags) => {
      const transport = fakeTransport();
      const models = createModelClient({ db: env.DB, transport, env: flags });

      await expect(models.generateText("write", "k", REQUEST)).rejects.toThrow(
        ModelCallsDisabledError,
      );
      await expect(models.embed("e", ["x"])).rejects.toThrow(
        ModelCallsDisabledError,
      );
      await expect(
        models.judge(
          "j",
          { title: "t" },
          { q: { type: "noul", instructions: "i" } },
        ),
      ).rejects.toThrow(ModelCallsDisabledError);
      expect(transport.calls.length).toBe(0);
      expect(await ledgerCount()).toBe(0);
    },
  );

  it("returns the stored result for a completed key without a new request", async () => {
    const transport = fakeTransport();
    const models = createModelClient({
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });

    const first = await models.generateText("reason", "done", REQUEST);
    expect(first.text).toBe("Hello, world");
    expect(transport.calls.length).toBe(1);

    const second = await models.generateText("reason", "done", REQUEST);
    expect(second).toEqual(first);
    expect(transport.calls.length).toBe(1);
  });

  it("parses typed Jev answers and embeddings", async () => {
    const transport = fakeTransport();
    const models = createModelClient({
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });

    const answers = await models.judge(
      "judge-1",
      { title: "t", body: "b" },
      {
        aboutWeather: { type: "noul", instructions: "i" },
        topic: {
          type: "choice",
          instructions: "i",
          criteria: { weather: "a", sports: "b" },
        },
        clarity: {
          type: "score",
          instructions: "i",
          criteria: ["0", "1", "2"],
        },
      },
    );
    expect(answers.aboutWeather.noul).toBe(0.99);
    expect(answers.topic.choice).toBe("weather");
    const { clarity } = jevResponse.result.answers;
    expect(answers.clarity).toEqual({
      score: clarity.score,
      confidence: clarity.confidence,
      probabilities: clarity.probabilities,
    });

    const vectors = await models.embed("embed-1", ["a", "b"]);
    expect(vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(transport.calls.map((c) => c.model)).toEqual([
      "typesafe/jev",
      "@cf/baai/bge-m3",
    ]);
  });

  it("marks a transport error failed and releases the reservation", async () => {
    const transport = fakeTransport(() => {
      throw new TransportHttpError(502, "bad gateway");
    });
    const models = createModelClient({
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });

    await expect(models.generateText("write", "boom", REQUEST)).rejects.toThrow(
      TransportHttpError,
    );
    expect(await ledgerRow("boom")).toMatchObject({
      status: "failed",
      attempt: 1,
    });
    expect(await budgetRow("gateway")).toMatchObject({
      reserved_micros: 0,
      spent_micros: 0,
    });

    // A failed key can be retried.
    const ok = createModelClient({
      db: env.DB,
      transport: fakeTransport(),
      env: ENABLED,
      now: () => NOW,
    });
    await expect(ok.generateText("write", "boom", REQUEST)).resolves.toEqual(
      expect.objectContaining({ text: "OK" }),
    );
    expect(await ledgerRow("boom")).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  });

  it("charges the estimate when the response cannot be parsed", async () => {
    const transport = fakeTransport(() => ({ unexpected: true }));
    const models = createModelClient({
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });

    await expect(
      models.generateText("write", "bad", REQUEST),
    ).rejects.toThrow();
    const row = await ledgerRow("bad");
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.cost_micros).toBeGreaterThan(0);
    expect(await budgetRow("gateway")).toMatchObject({
      reserved_micros: 0,
      spent_micros: row?.cost_micros,
    });
  });
});
