import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { LEASE_MS } from "../../src/providers/ledger";
import {
  CallInProgressError,
  CallUnknownError,
  createModelClient,
} from "../../src/providers/models";
import { ENABLED, NOW, fakeTransport, ledgerRow, resetLedger } from "./fakes";

const REQUEST = { system: "s", prompt: "p", maxOutputTokens: 16 };

function client(now = NOW) {
  const transport = fakeTransport();
  const models = createModelClient({
    db: env.DB,
    transport,
    env: ENABLED,
    now: () => now,
  });
  return { models, transport };
}

/** An `in_flight` row left behind by a caller that went away. */
async function strandedRow(
  key: string,
  leaseExpiresAt: number,
  sentAt: number | null,
) {
  await env.DB.prepare(
    `INSERT INTO llm_calls (logical_key, slot, model, channel, status, attempt,
       lease_expires_at, sent_at, created_at, updated_at)
     VALUES (?1, 'write', 'google/gemini-3.8-flash', 'gateway', 'in_flight', 1,
       ?2, ?3, ?4, ?4)`,
  )
    .bind(key, leaseExpiresAt, sentAt, NOW - LEASE_MS)
    .run();
}

describe("llm_calls ledger", () => {
  beforeEach(() => resetLedger());

  it("sends one request for two concurrent calls with the same key", async () => {
    const { models, transport } = client();
    const results = await Promise.allSettled([
      models.generateText("write", "same", REQUEST),
      models.generateText("write", "same", REQUEST),
    ]);

    expect(transport.calls.length).toBe(1);
    const first = results.find((r) => r.status === "fulfilled");
    expect(first).toBeDefined();
    for (const result of results) {
      if (result.status === "fulfilled") {
        expect(result.value).toEqual(
          (first as PromiseFulfilledResult<unknown>).value,
        );
      } else {
        expect(result.reason).toBeInstanceOf(CallInProgressError);
      }
    }
  });

  it("takes over an expired lease when the request was never sent", async () => {
    await strandedRow("stale", NOW - 1, null);
    const { models, transport } = client();

    await models.generateText("write", "stale", REQUEST);

    expect(transport.calls.length).toBe(1);
    expect(await ledgerRow("stale")).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  });

  it("does not take over a live lease", async () => {
    await strandedRow("live", NOW + 60_000, null);
    const { models, transport } = client();

    await expect(models.generateText("write", "live", REQUEST)).rejects.toThrow(
      CallInProgressError,
    );
    expect(transport.calls.length).toBe(0);
    expect(await ledgerRow("live")).toMatchObject({ status: "in_flight" });
  });

  it("marks an expired, already sent call unknown and does not resend", async () => {
    await strandedRow("sent", NOW - 1, NOW - LEASE_MS);
    const { models, transport } = client();

    await expect(models.generateText("write", "sent", REQUEST)).rejects.toThrow(
      CallUnknownError,
    );
    expect(transport.calls.length).toBe(0);
    expect(await ledgerRow("sent")).toMatchObject({ status: "unknown" });

    // Stays unknown: later callers do not resend either.
    await expect(models.generateText("write", "sent", REQUEST)).rejects.toThrow(
      CallUnknownError,
    );
    expect(transport.calls.length).toBe(0);
  });
});
