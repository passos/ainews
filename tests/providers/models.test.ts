import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  UnsupportedModelError,
  buildTextInput,
} from "../../src/providers/adapters";
import { costMicros } from "../../src/providers/budget";
import {
  DEFAULT_PRICES,
  DEFAULT_SLOTS,
  SETTING_PRICES,
  SETTING_SLOTS,
} from "../../src/providers/defaults";
import { JevInputTooLargeError, estimateTokens } from "../../src/providers/jev";
import {
  ModelCallsDisabledError,
  ModelConfigError,
  createModelClient,
} from "../../src/providers/models";
import { TransportHttpError } from "../../src/providers/transport";
import { googleResponse, jevResponse } from "./fixtures";
import {
  ENABLED,
  NOW,
  TODAY,
  budgetRow,
  fakeTransport,
  ledgerRow,
  resetLedger,
} from "./fakes";

const REQUEST = { system: "s", prompt: "p", maxOutputTokens: 16 };

const WRITE_MODEL = DEFAULT_SLOTS.write.model;

async function setSetting(key: string, value: unknown): Promise<void> {
  await env.DB.prepare("UPDATE settings SET value = ?2 WHERE key = ?1")
    .bind(key, JSON.stringify(value))
    .run();
}

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
      const models = createModelClient({
        tier: 1,
        db: env.DB,
        transport,
        env: flags,
      });

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
      tier: 1,
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });

    const first = await models.generateText("reason", "done", REQUEST);
    expect(first.text).toBe("OK");
    expect(transport.calls.length).toBe(1);

    const second = await models.generateText("reason", "done", REQUEST);
    expect(second).toEqual(first);
    expect(transport.calls.length).toBe(1);
  });

  it("parses typed Jev answers and embeddings", async () => {
    const transport = fakeTransport();
    const models = createModelClient({
      tier: 1,
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

  it("charges the estimate when the transport throws, and a retry adds its actual cost", async () => {
    const transport = fakeTransport(() => {
      throw new TransportHttpError(502, "bad gateway");
    });
    const models = createModelClient({
      tier: 1,
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });

    await expect(models.generateText("write", "boom", REQUEST)).rejects.toThrow(
      TransportHttpError,
    );
    // The request may have run and been billed: the estimate is spent.
    const price = DEFAULT_PRICES[WRITE_MODEL];
    const estimate = costMicros(
      price,
      estimateTokens(buildTextInput(WRITE_MODEL, REQUEST)),
      REQUEST.maxOutputTokens,
    );
    expect(estimate).toBeGreaterThan(0);
    expect(await ledgerRow("boom")).toMatchObject({
      status: "failed",
      attempt: 1,
      cost_micros: estimate,
    });
    expect(await budgetRow("gateway")).toMatchObject({
      reserved_micros: 0,
      spent_micros: estimate,
    });

    // A failed key can be retried.
    const ok = createModelClient({
      tier: 1,
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
    const { promptTokenCount, thoughtsTokenCount } =
      googleResponse.usageMetadata;
    expect(await budgetRow("gateway")).toMatchObject({
      reserved_micros: 0,
      spent_micros:
        estimate + costMicros(price, promptTokenCount, thoughtsTokenCount),
    });
  });

  it("charges the estimate when the response cannot be parsed", async () => {
    const transport = fakeTransport(() => ({ unexpected: true }));
    const models = createModelClient({
      tier: 1,
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

  it("fails an unsupported model before taking a lease, and the key works once the slot is fixed", async () => {
    const transport = fakeTransport();
    const models = createModelClient({
      tier: 1,
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });
    try {
      await setSetting(SETTING_SLOTS, {
        ...DEFAULT_SLOTS,
        write: { model: "mistral/unknown", channel: "gateway" },
      });
      await setSetting(SETTING_PRICES, {
        ...DEFAULT_PRICES,
        "mistral/unknown": { in: 1, out: 1 },
      });

      await expect(
        models.generateText("write", "cfg", REQUEST),
      ).rejects.toThrow(UnsupportedModelError);
      expect(await ledgerRow("cfg")).toBeNull();
      expect(transport.calls.length).toBe(0);
    } finally {
      await setSetting(SETTING_SLOTS, DEFAULT_SLOTS);
      await setSetting(SETTING_PRICES, DEFAULT_PRICES);
    }

    await expect(models.generateText("write", "cfg", REQUEST)).resolves.toEqual(
      expect.objectContaining({ text: "OK" }),
    );
    expect(await ledgerRow("cfg")).toMatchObject({
      status: "completed",
      attempt: 1,
    });
  });

  it("readPage refuses a read slot that is not a jina/ model before any request", async () => {
    const transport = fakeTransport();
    const models = createModelClient({
      tier: 1,
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });
    await env.DB.prepare(
      "INSERT INTO budgets (day, channel, cap_micros) VALUES (?1, 'jina', 1000000)",
    )
      .bind(TODAY)
      .run();
    try {
      await setSetting(SETTING_SLOTS, {
        ...DEFAULT_SLOTS,
        read: { model: WRITE_MODEL, channel: "jina" },
      });
      await expect(models.readPage("https://a.example/p", 1)).rejects.toThrow(
        ModelConfigError,
      );
      expect(transport.calls.length).toBe(0);
      expect(await ledgerCount()).toBe(0);
    } finally {
      await setSetting(SETTING_SLOTS, DEFAULT_SLOTS);
    }
  });

  it("rejects a Jev input that is still too large before taking a lease", async () => {
    const transport = fakeTransport();
    const models = createModelClient({
      tier: 1,
      db: env.DB,
      transport,
      env: ENABLED,
      now: () => NOW,
    });

    await expect(
      models.judge(
        "huge",
        { title: "t".repeat(100_000), body: "b" },
        { q: { type: "noul", instructions: "i" } },
      ),
    ).rejects.toThrow(JevInputTooLargeError);
    expect(await ledgerRow("huge")).toBeNull();
    expect(transport.calls.length).toBe(0);
    expect(await budgetRow("workers_ai")).toMatchObject({
      reserved_micros: 0,
      spent_micros: 0,
    });
  });

  it.each([-100, 0, 1.5])(
    "rejects maxOutputTokens %s before taking a lease",
    async (maxOutputTokens) => {
      const transport = fakeTransport();
      const models = createModelClient({
        tier: 1,
        db: env.DB,
        transport,
        env: ENABLED,
        now: () => NOW,
      });
      const before = await budgetRow("gateway");

      await expect(
        models.generateText("write", "neg", { ...REQUEST, maxOutputTokens }),
      ).rejects.toThrow(RangeError);
      expect(transport.calls.length).toBe(0);
      expect(await ledgerRow("neg")).toBeNull();
      expect(await budgetRow("gateway")).toEqual(before);
    },
  );
});
