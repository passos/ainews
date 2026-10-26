import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  correctFundingRound,
  decideFundingRound,
  listFundingObservations,
  listPendingFundingRounds,
  resolveFundingObservation,
} from "../../src/server/admin/ops";
import { captureFundingObservation } from "../../src/pipeline/funding/observations";
import { extractedRoundSchema } from "../../src/lib/funding/types";
import { seedArticle, seedReview } from "../publication/helpers";
import { adminOr403 } from "../../src/server/admin/access";
import { getDb } from "../../src/server/db/client";
import {
  getFundingRoundDetails,
  getPublishedFundingRounds,
} from "../../src/server/publication/funding";
import { seedRound } from "../helpers/funding";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM funding_observations"),
    env.DB.prepare("DELETE FROM corrections"),
    env.DB.prepare("DELETE FROM funding_rounds"),
  ]);
});

async function status(id: number): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT status FROM funding_rounds WHERE id = ?1",
  )
    .bind(id)
    .first<{ status: string }>();
  return row!.status;
}

describe("admin funding review", () => {
  it("carries the nearest published ancestor through private pending edits into final audit", async () => {
    const first = await seedRound({ status: "published", amount: 10 });
    await correctFundingRound(env.DB, {
      roundId: first,
      amount: 12,
      currency: "USD",
      reason: "PRIVATE intermediate reason",
    });
    const pending = (await listPendingFundingRounds(env.DB))[0].id;
    await env.DB.prepare(
      "CREATE TRIGGER fail_final_audit BEFORE INSERT ON corrections BEGIN SELECT RAISE(ABORT,'final audit failed'); END",
    ).run();
    try {
      await expect(
        correctFundingRound(env.DB, {
          roundId: pending,
          amount: 11,
          currency: "USD",
          reason: "Final verified amount",
        }),
      ).rejects.toThrow(/final audit failed/);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_final_audit").run();
    }
    expect(await listPendingFundingRounds(env.DB)).toMatchObject([
      { id: pending, amount: 12 },
    ]);
    await correctFundingRound(env.DB, {
      roundId: pending,
      amount: 11,
      currency: "USD",
      reason: "Final verified amount",
    });
    const [final] = await listPendingFundingRounds(env.DB);
    expect(final).toMatchObject({ previousId: first, previousAmount: 10 });
    await decideFundingRound(env.DB, final.id, "published");
    const details = await getFundingRoundDetails(getDb(env.DB), final.id);
    expect(details!.corrections).toHaveLength(1);
    expect(details!.corrections[0].body).toMatch(
      /10 USD.*11 USD.*Final verified amount/,
    );
    expect(JSON.stringify(details)).not.toMatch(/PRIVATE/);
    await decideFundingRound(env.DB, final.id, "published");
    expect(
      (await getFundingRoundDetails(getDb(env.DB), final.id))!.corrections,
    ).toHaveLength(1);
  });

  it("uses ancestry depth rather than row ID to choose a restored published version", async () => {
    const active = await seedRound({ companyKey: "depth" });
    const nearest = await seedRound({
      companyKey: "depth",
      status: "published",
      supersededBy: active,
    });
    await seedRound({
      companyKey: "depth",
      status: "published",
      supersededBy: nearest,
    });
    await decideFundingRound(env.DB, active, "rejected");
    expect(
      (await getPublishedFundingRounds(getDb(env.DB))).items.map((r) => r.id),
    ).toEqual([nearest]);
  });

  it("restores the nearest pending ancestor when no published ancestor exists", async () => {
    const first = await seedRound({ amount: 10 });
    await correctFundingRound(env.DB, {
      roundId: first,
      amount: 100,
      currency: "USD",
      reason: "Incorrect report",
    });
    const next = (await listPendingFundingRounds(env.DB))[0].id;
    expect(
      await Promise.all([
        decideFundingRound(env.DB, next, "rejected"),
        decideFundingRound(env.DB, next, "rejected"),
      ]),
    ).toContain(true);
    expect(await listPendingFundingRounds(env.DB)).toMatchObject([
      { id: first, amount: 10 },
    ]);
    expect(await decideFundingRound(env.DB, next, "rejected")).toBe(false);
    expect(await decideFundingRound(env.DB, first, "published")).toBe(true);
  });

  it("rejects missing Access credentials for funding operations with 403", async () => {
    const accessEnv = {
      SITE_URL: "https://news.ioenv.com",
      ADMIN_EMAIL: "admin@example.com",
      ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
      ACCESS_AUD: "test-aud",
    };
    for (const name of [
      "listPendingFundingRounds",
      "decideFundingRound",
      "correctFundingRound",
      "listFundingObservations",
      "resolveFundingObservation",
    ]) {
      await expect(
        adminOr403(
          new Request(`https://news.ioenv.com/_serverFn/${name}`, {
            method: name.startsWith("list") ? "GET" : "POST",
          }),
          accessEnv,
        ),
      ).rejects.toSatisfy(
        (error: unknown) => error instanceof Response && error.status === 403,
      );
    }
  });

  it.each([1, 2])(
    "rejecting %i pending revisions restores the last published version without leaking rejected edits",
    async (count) => {
      const id = await seedRound({ status: "published", amount: 10 });
      let previous = id;
      for (let i = 0; i < count; i++) {
        expect(
          await correctFundingRound(env.DB, {
            roundId: previous,
            amount: 900 + i,
            currency: "USD",
            reason: "PRIVATE unpublished change",
          }),
        ).toBe(true);
        const next = await env.DB.prepare(
          "SELECT id FROM funding_rounds WHERE superseded_by IS NULL",
        ).first<{ id: number }>();
        previous = next!.id;
      }
      expect((await getPublishedFundingRounds(getDb(env.DB))).total).toBe(0);
      expect(await decideFundingRound(env.DB, previous, "rejected")).toBe(true);
      const list = await getPublishedFundingRounds(getDb(env.DB));
      expect(list.items.map((row) => row.id)).toEqual([id]);
      expect(
        JSON.stringify(await getFundingRoundDetails(getDb(env.DB), id)),
      ).not.toMatch(/PRIVATE|900|901/);
      const active = await env.DB.prepare(
        "SELECT id FROM funding_rounds WHERE superseded_by IS NULL",
      ).all<{ id: number }>();
      expect(active.results).toEqual([{ id }]);
      expect(await decideFundingRound(env.DB, previous, "published")).toBe(
        false,
      );
      expect(
        await correctFundingRound(env.DB, {
          roundId: previous,
          amount: 1,
          currency: "USD",
          reason: "Cannot edit rejected",
        }),
      ).toBe(false);
      expect(
        await correctFundingRound(env.DB, {
          roundId: id,
          amount: 11,
          currency: "USD",
          reason: "Next legitimate report",
        }),
      ).toBe(true);
    },
  );

  it("lists only active pending rounds, oldest first", async () => {
    const a = await seedRound({ company: "A" });
    await seedRound({ company: "Published", status: "published" });
    await seedRound({ company: "Rejected", status: "rejected" });
    const b = await seedRound({ company: "B" });
    await seedRound({ company: "Old", supersededBy: b });
    const list = await listPendingFundingRounds(env.DB);
    expect(list.map((r) => r.id)).toEqual([a, b]);
  });

  it("publishes a pending round once", async () => {
    const id = await seedRound();
    expect(await decideFundingRound(env.DB, id, "published")).toBe(true);
    expect(await status(id)).toBe("published");
    // Not pending any more: a second decision changes nothing.
    expect(await decideFundingRound(env.DB, id, "rejected")).toBe(false);
    expect(await status(id)).toBe("published");
  });

  it("rejects a pending round", async () => {
    const id = await seedRound();
    expect(await decideFundingRound(env.DB, id, "rejected")).toBe(true);
    expect(await status(id)).toBe("rejected");
  });

  it("does not decide a replaced round", async () => {
    const next = await seedRound({ companyKey: "x" });
    const old = await seedRound({ companyKey: "x", supersededBy: next });
    expect(await decideFundingRound(env.DB, old, "published")).toBe(false);
    expect(await status(old)).toBe("pending_review");
  });

  it("writes corrections atomically when superseding, and publishing does not duplicate them", async () => {
    const id = await seedRound({ status: "published", amount: 10 });
    expect(
      await correctFundingRound(env.DB, {
        roundId: id,
        amount: 12,
        currency: "USD",
        reason: "Correct amount",
      }),
    ).toBe(true);
    const corrections = await env.DB.prepare(
      "SELECT target_id, body FROM corrections",
    ).all();
    const next = await env.DB.prepare(
      "SELECT id FROM funding_rounds WHERE superseded_by IS NULL",
    ).first<{ id: number }>();
    expect(corrections.results).toEqual([
      {
        target_id: next!.id,
        body: "Funding record updated: 10 USD to 12 USD: Correct amount",
      },
    ]);
    await decideFundingRound(env.DB, next!.id, "published");
    await decideFundingRound(env.DB, next!.id, "published");
    expect(
      (await env.DB.prepare("SELECT count(*) n FROM corrections").first<{
        n: number;
      }>())!.n,
    ).toBe(1);
  });

  it("concurrent corrections CAS the same old row without orphans or self-pointers", async () => {
    const id = await seedRound({ status: "published", amount: 10 });
    const results = await Promise.all(
      [12, 13].map((amount) =>
        correctFundingRound(
          env.DB,
          {
            roundId: id,
            amount,
            currency: "USD",
            reason: "Concurrent correction",
          },
          500,
        ),
      ),
    );
    expect(results.sort()).toEqual([false, true]);
    const rows = await env.DB.prepare(
      "SELECT id,superseded_by FROM funding_rounds ORDER BY id",
    ).all<{ id: number; superseded_by: number | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0].superseded_by).toBe(rows.results[1].id);
    expect(rows.results[1].superseded_by).toBeNull();
    expect(
      (await env.DB.prepare("SELECT count(*) n FROM corrections").first<{
        n: number;
      }>())!.n,
    ).toBe(1);
  });

  it("rolls back the entire correction if its audit insert fails", async () => {
    const id = await seedRound({ status: "published", amount: 10 });
    await env.DB.prepare(
      "CREATE TRIGGER funding_audit_fail BEFORE INSERT ON corrections BEGIN SELECT RAISE(ABORT, 'audit failure'); END",
    ).run();
    try {
      await expect(
        correctFundingRound(env.DB, {
          roundId: id,
          amount: 12,
          currency: "USD",
          reason: "Correct amount",
        }),
      ).rejects.toThrow(/audit failure/);
    } finally {
      await env.DB.prepare("DROP TRIGGER funding_audit_fail").run();
    }
    expect(
      await env.DB.prepare(
        "SELECT amount,superseded_by FROM funding_rounds",
      ).all(),
    ).toMatchObject({ results: [{ amount: 10, superseded_by: null }] });
  });

  it.each([
    { amount: -1, currency: "USD", reason: "valid reason" },
    { amount: 1.5, currency: "USD", reason: "valid reason" },
    { amount: 1, currency: "12!", reason: "valid reason" },
    { amount: 1, currency: "USD", reason: "   " },
  ])("rejects invalid correction input before writing: %j", async (input) => {
    const id = await seedRound();
    await expect(
      correctFundingRound(env.DB, { roundId: id, ...input }),
    ).rejects.toThrow();
    expect(
      (await env.DB.prepare("SELECT count(*) n FROM funding_rounds").first<{
        n: number;
      }>())!.n,
    ).toBe(1);
  });

  it("rejecting a replacement writes no correction", async () => {
    const next = await seedRound({ companyKey: "k2" });
    await seedRound({
      companyKey: "k2",
      status: "published",
      supersededBy: next,
    });
    await decideFundingRound(env.DB, next, "rejected");
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM corrections").first<{
        n: number;
      }>())!.n,
    ).toBe(0);
  });

  it("an administrator's correction makes a new pending version and keeps the old row", async () => {
    const id = await seedRound({
      company: "Acme",
      companyKey: "acme",
      status: "published",
      amount: 10_000_000,
      investors: ["Alpha"],
    });
    expect(
      await correctFundingRound(env.DB, {
        roundId: id,
        amount: 12_000_000,
        currency: "usd",
        reason: "Company filing gives the final figure",
      }),
    ).toBe(true);
    const { results } = await env.DB.prepare(
      "SELECT id, status, amount, amount_micros, superseded_by, correction_reason, investors FROM funding_rounds ORDER BY id",
    ).all<{
      id: number;
      status: string;
      amount: number;
      amount_micros: number;
      superseded_by: number | null;
      correction_reason: string | null;
      investors: string;
    }>();
    expect(results).toHaveLength(2);
    const [old, next] = results;
    expect(old).toMatchObject({
      id,
      status: "published",
      amount: 10_000_000,
      superseded_by: next.id,
    });
    expect(next).toMatchObject({
      status: "pending_review",
      amount: 12_000_000,
      amount_micros: 12_000_000_000_000,
      superseded_by: null,
      correction_reason: "Company filing gives the final figure",
      investors: '["Alpha"]',
    });
  });

  it("cannot correct a missing, replaced or rejected round", async () => {
    const rejected = await seedRound({ status: "rejected" });
    const input = { amount: 1, currency: "USD", reason: "typo fix here" };
    expect(
      await correctFundingRound(env.DB, { roundId: 99999, ...input }),
    ).toBe(false);
    expect(
      await correctFundingRound(env.DB, { roundId: rejected, ...input }),
    ).toBe(false);
    const active = await seedRound();
    const replaced = await seedRound({ supersededBy: active });
    expect(
      await correctFundingRound(env.DB, { roundId: replaced, ...input }),
    ).toBe(false);
  });
});

const OBSERVATION_BODY = "Acme raised a Seed round of 10 USD, led by Alpha.";

/** An approved Finance article with one unresolved observation (no date). */
async function seedObservation(): Promise<{ id: string; articleId: number }> {
  const industry = await env.DB.prepare(
    "SELECT id FROM industries WHERE slug = 'finance'",
  ).first<{ id: number }>();
  if (!industry) await seedRound({ status: "rejected" });
  const finance = (await env.DB.prepare(
    "SELECT i.id industry_id, s.id source_id FROM industries i JOIN sources s ON s.industry_id = i.id WHERE i.slug = 'finance'",
  ).first<{ industry_id: number; source_id: number }>())!;
  const articleId = await seedArticle({
    industryId: finance.industry_id,
    sourceId: finance.source_id,
    title: "Acme raises seed",
    url: `https://news.example/acme-${Math.random()}`,
  });
  await seedReview(articleId, "approved");
  await env.BODIES.put(`bodies/${articleId}/sha-current.md`, OBSERVATION_BODY);
  const quote = { quote: OBSERVATION_BODY };
  const payload = extractedRoundSchema.parse({
    identity: {
      companyName: { value: "Acme", evidence: quote },
      roundName: { value: "Seed", evidence: quote },
      companyHost: null,
      announcedDate: null,
      sameEventEvidence: null,
    },
    reportedFacts: {
      amount: { value: 10, evidence: quote },
      currency: { value: "USD", evidence: quote },
    },
    correctionPatch: {},
    correctionReason: null,
  });
  const row = await captureFundingObservation(
    env.DB,
    articleId,
    "sha-current",
    "funding-test",
    0,
    payload,
    OBSERVATION_BODY,
    1,
  );
  expect(row.state).toBe("unresolved");
  return { id: row.id, articleId };
}

async function observationState(id: string) {
  return env.DB.prepare(
    "SELECT state, decision_revision FROM funding_observations WHERE id = ?1",
  )
    .bind(id)
    .first<{ state: string; decision_revision: number }>();
}

async function activeRounds() {
  return (
    await env.DB.prepare(
      "SELECT * FROM funding_rounds WHERE superseded_by IS NULL AND status != 'rejected' ORDER BY id",
    ).all<{
      id: number;
      company_key: string;
      round_key: string;
      announced_date: string | null;
      status: string;
      source_articles: string;
    }>()
  ).results;
}

describe("admin funding observation queue", () => {
  it("lists unresolved observations with evidence and same-company candidates", async () => {
    const candidate = await seedRound({
      company: "Acme",
      companyKey: "entity:acme",
      roundKey: "event:seed:2026-10-19",
    });
    await seedRound({ company: "Other", companyKey: "entity:other" });
    const { id, articleId } = await seedObservation();
    const [view] = await listFundingObservations(env.DB);
    expect(view).toMatchObject({
      id,
      articleId,
      state: "unresolved",
      decisionRevision: 0,
      companyName: "Acme",
      roundName: "Seed",
      announcedDate: null,
    });
    expect(view.evidence).toContainEqual({
      field: "companyName",
      quote: OBSERVATION_BODY,
    });
    expect(view.candidates.map((c) => c.id)).toEqual([candidate]);
  });

  it("attaches an observation to an existing round of the same company once", async () => {
    const target = await seedRound({
      company: "Acme",
      companyKey: "entity:acme",
      roundKey: "event:seed:2026-10-19",
      amount: null,
    });
    const other = await seedRound({
      company: "Other",
      companyKey: "entity:other",
    });
    const { id, articleId } = await seedObservation();
    expect(
      await resolveFundingObservation(env.DB, env.BODIES, {
        action: "attach_existing",
        observationId: id,
        expectedRevision: 0,
        roundId: other,
        reason: "Wrong company",
      }),
    ).toMatchObject({ updated: false });
    expect(await observationState(id)).toEqual({
      state: "unresolved",
      decision_revision: 0,
    });
    expect(
      await resolveFundingObservation(env.DB, env.BODIES, {
        action: "attach_existing",
        observationId: id,
        expectedRevision: 0,
        roundId: target,
        reason: "Same seed round",
      }),
    ).toMatchObject({ updated: true });
    expect(await observationState(id)).toEqual({
      state: "applied",
      decision_revision: 1,
    });
    const acme = (await activeRounds()).filter(
      (r) => r.company_key === "entity:acme",
    );
    expect(acme).toHaveLength(1);
    expect(acme[0].round_key).toBe("event:seed:2026-10-19");
    expect(
      JSON.parse(acme[0].source_articles).map(
        (s: { articleId: number }) => s.articleId,
      ),
    ).toContain(articleId);
    expect(
      await resolveFundingObservation(env.DB, env.BODIES, {
        action: "attach_existing",
        observationId: id,
        expectedRevision: 0,
        roundId: target,
        reason: "Stale page",
      }),
    ).toMatchObject({ updated: false });
  });

  it("ignores an action whose revision differs from the observation's", async () => {
    const { id } = await seedObservation();
    expect(
      await resolveFundingObservation(env.DB, env.BODIES, {
        action: "reject",
        observationId: id,
        expectedRevision: 1,
        reason: "Page from another revision",
      }),
    ).toMatchObject({ updated: false });
    expect(await observationState(id)).toEqual({
      state: "unresolved",
      decision_revision: 0,
    });
  });

  it("confirms a new round with an explicitly unknown announcement date", async () => {
    const { id } = await seedObservation();
    expect(
      await resolveFundingObservation(env.DB, env.BODIES, {
        action: "confirm_new",
        observationId: id,
        expectedRevision: 0,
        companyName: "Acme",
        roundName: "Seed",
        announcedDate: null,
        reason: "Date not disclosed",
      }),
    ).toMatchObject({ updated: true, result: "inserted" });
    expect(await activeRounds()).toEqual([
      expect.objectContaining({
        company_key: "entity:acme",
        round_key: "event:seed:unknown",
        announced_date: null,
        status: "pending_review",
      }),
    ]);
    expect(await observationState(id)).toEqual({
      state: "applied",
      decision_revision: 1,
    });
  });

  it("rejects an observation without writing a round, and a stale page cannot revive it", async () => {
    const { id } = await seedObservation();
    expect(
      await resolveFundingObservation(env.DB, env.BODIES, {
        action: "reject",
        observationId: id,
        expectedRevision: 0,
        reason: "Not a funding round",
      }),
    ).toMatchObject({ updated: true });
    expect(await observationState(id)).toEqual({
      state: "rejected",
      decision_revision: 1,
    });
    expect(await activeRounds()).toEqual([]);
    expect(await listFundingObservations(env.DB)).toEqual([]);
    for (const expectedRevision of [0, 1])
      expect(
        await resolveFundingObservation(env.DB, env.BODIES, {
          action: "confirm_new",
          observationId: id,
          expectedRevision,
          companyName: "Acme",
          roundName: "Seed",
          announcedDate: null,
          reason: "Stale page",
        }),
      ).toMatchObject({ updated: false });
    expect(await activeRounds()).toEqual([]);
  });
});
