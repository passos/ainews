import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getFundingPage,
  getFundingRoundDetails,
  getFundingTrends,
  getPublishedFundingRounds,
} from "../../src/server/publication/funding";
import { seedRound } from "../helpers/funding";
import {
  DISCLAIMER,
  db,
  resetPublication,
  seedArticle,
  seedReview,
  seedSections,
} from "../publication/helpers";

let fin: { industryId: number; sourceId: number };

beforeEach(async () => {
  await resetPublication();
  ({ finance: fin } = await seedSections());
});

describe("public funding read layer", () => {
  it("totals native disclosed amounts exactly beyond safe micro-number range", async () => {
    const large = await seedRound({
      status: "published",
      amount: 13_000_000_000,
      amountMicros: null,
    });
    await seedRound({
      status: "published",
      amount: 8_000_000_001,
      currency: "EUR",
      amountMicros: null,
    });
    await seedRound({
      status: "published",
      amount: 900_000_000_001,
      currency: "JPY",
      amountMicros: null,
    });
    await seedRound({
      status: "published",
      amount: 123,
      currency: "XYZ",
      amountMicros: null,
    });
    await seedRound({ status: "published", amount: null });
    for (const amount of [8_000_000_000, 8_000_000_001]) {
      await seedRound({ status: "published", sector: "robotics", amount });
    }
    const page = await getFundingPage(db());
    expect(page.list.items.find((r) => r.id === large)!.amountMicros).toBe(
      "13000000000000000",
    );
    expect(page.trends.bySector).toEqual([
      {
        sector: "fintech",
        rounds: 5,
        disclosedRounds: 4,
        convertedRounds: 3,
        totalMicros: "27670000001086700",
      },
      {
        sector: "robotics",
        rounds: 2,
        disclosedRounds: 2,
        convertedRounds: 2,
        totalMicros: "16000000001000000",
      },
    ]);
    expect(() => JSON.stringify(page)).not.toThrow();
  });

  it("hides facts, counts, history and trends once every source is revoked", async () => {
    const id = await seedRound({
      status: "published",
      investors: ["Secret Investor"],
    });
    await env.DB.prepare("UPDATE reviews SET decision = 'rejected'").run();
    expect(await getPublishedFundingRounds(db())).toMatchObject({
      total: 0,
      items: [],
    });
    expect(await getFundingTrends(db())).toEqual({
      roundCount: 0,
      bySector: [],
      byStage: [],
      investorActivity: [],
    });
    expect(await getFundingRoundDetails(db(), id)).toBeNull();
  });

  it("hides a round once any one of its sources is revoked, and a round without sources", async () => {
    const a = await seedArticle({
      industryId: fin.industryId,
      sourceId: fin.sourceId,
      title: "A",
      url: "https://news.example/a",
    });
    const b = await seedArticle({
      industryId: fin.industryId,
      sourceId: fin.sourceId,
      title: "B",
      url: "https://news.example/b",
    });
    await seedReview(a, "approved");
    await seedReview(b, "approved");
    const id = await seedRound({
      status: "published",
      sector: "robotics",
      investors: ["Only A Investor"],
      sources: [
        { articleId: a, url: "https://news.example/a", title: "A" },
        { articleId: b, url: "https://news.example/b", title: "B" },
      ],
    });
    await seedRound({ status: "published", sources: [] });
    expect(
      (await getPublishedFundingRounds(db())).items.map((r) => r.id),
    ).toEqual([id]);
    await seedReview(a, "rejected");
    expect(await getPublishedFundingRounds(db())).toMatchObject({
      total: 0,
      items: [],
    });
    expect((await getFundingTrends(db())).roundCount).toBe(0);
    expect(await getFundingRoundDetails(db(), id)).toBeNull();
  });

  it("does not revive old derived facts when a different article body is approved", async () => {
    const id = await seedRound({ status: "published" });
    const row = await env.DB.prepare(
      "SELECT source_articles FROM funding_rounds WHERE id = ?1",
    )
      .bind(id)
      .first<{ source_articles: string }>();
    const source = JSON.parse(row!.source_articles)[0];
    await env.DB.prepare(
      "UPDATE articles SET body_sha = 'new-body' WHERE id = ?1",
    )
      .bind(source.articleId)
      .run();
    await seedReview(source.articleId, "approved", "new-body");
    expect(await getPublishedFundingRounds(db())).toMatchObject({
      total: 0,
      items: [],
    });
    expect((await getFundingTrends(db())).roundCount).toBe(0);
    expect(await getFundingRoundDetails(db(), id)).toBeNull();
  });

  it("details retain published ancestors but never expose pending or rejected successors", async () => {
    const third = await seedRound({
      companyKey: "history",
      status: "published",
      amount: 30,
    });
    const second = await seedRound({
      companyKey: "history",
      status: "published",
      amount: 20,
      supersededBy: third,
    });
    const first = await seedRound({
      companyKey: "history",
      status: "published",
      amount: 10,
      supersededBy: second,
    });
    await env.DB.prepare(
      "INSERT INTO corrections (target_type,target_id,body,created_at) VALUES ('funding_rounds',?1,'Approved correction',1)",
    )
      .bind(first)
      .run();
    const detail = await getFundingRoundDetails(db(), third);
    expect(detail?.versions.map((v) => v.amount)).toEqual([30, 20, 10]);
    expect(detail?.corrections).toContainEqual({
      body: "Approved correction",
      createdAt: 1,
    });
    expect(await getFundingRoundDetails(db(), first)).toBeNull();
    const pending = await seedRound({
      companyKey: "history",
      amount: 999,
      correctionReason: "SECRET reason",
      sources: [],
      status: "pending_review",
      supersededBy: third,
    });
    const json = JSON.stringify(await getFundingRoundDetails(db(), third));
    expect(json).not.toMatch(/999|SECRET/);
    expect(await getFundingRoundDetails(db(), pending)).toBeNull();
    await env.DB.prepare(
      "UPDATE funding_rounds SET status = 'rejected' WHERE id = ?1",
    )
      .bind(pending)
      .run();
    expect(
      JSON.stringify(await getFundingRoundDetails(db(), third)),
    ).not.toMatch(/999|SECRET/);
  });

  it("shows only published rounds", async () => {
    await seedRound({ company: "Pending", status: "pending_review" });
    await seedRound({ company: "Rejected", status: "rejected" });
    const live = await seedRound({ company: "Live", status: "published" });
    const list = await getPublishedFundingRounds(db());
    expect(list.items.map((r) => r.id)).toEqual([live]);
    expect(list.total).toBe(1);
    const trends = await getFundingTrends(db());
    expect(trends.roundCount).toBe(1);
  });

  it("hides a published version once a published newer one replaces it", async () => {
    const next = await seedRound({
      companyKey: "acme",
      status: "published",
      amount: 12_000_000,
    });
    await seedRound({
      companyKey: "acme",
      status: "published",
      amount: 10_000_000,
      supersededBy: next,
    });
    const list = await getPublishedFundingRounds(db());
    expect(list.items.map((r) => r.id)).toEqual([next]);
  });

  it("hides superseded published versions while replacement is pending or rejected", async () => {
    const next = await seedRound({
      companyKey: "acme",
      status: "pending_review",
    });
    await seedRound({
      companyKey: "acme",
      status: "published",
      supersededBy: next,
    });
    expect(
      (await getPublishedFundingRounds(db())).items.map((r) => r.id),
    ).toEqual([]);
    await env.DB.prepare(
      "UPDATE funding_rounds SET status = 'rejected' WHERE id = ?1",
    )
      .bind(next)
      .run();
    expect(
      (await getPublishedFundingRounds(db())).items.map((r) => r.id),
    ).toEqual([]);
  });

  it("filters by sector, stage and investor", async () => {
    const a = await seedRound({
      status: "published",
      sector: "fintech",
      stage: "seed",
      investors: ["Alpha Ventures"],
    });
    const b = await seedRound({
      status: "published",
      sector: "robotics",
      stage: "series_b",
      investors: ["Beta Capital", "alpha ventures"],
    });
    expect(
      (await getPublishedFundingRounds(db(), { sector: "fintech" })).items.map(
        (r) => r.id,
      ),
    ).toEqual([a]);
    expect(
      (await getPublishedFundingRounds(db(), { stage: "series_b" })).items.map(
        (r) => r.id,
      ),
    ).toEqual([b]);
    const both = await getPublishedFundingRounds(db(), {
      investor: "ALPHA VENTURES",
    });
    expect(both.items.map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it("uses the same filters for list counts and trend totals, with deterministic pagination", async () => {
    for (let i = 0; i < 23; i++)
      await seedRound({
        status: "published",
        sector: "fintech",
        amount: 10,
        investors: ["Alpha"],
      });
    await seedRound({ status: "published", sector: "robotics", amount: 999 });
    const page = await getFundingPage(db(), {
      sector: "fintech",
      investor: "ALPHA",
      page: 2,
    });
    expect(page.list).toMatchObject({ total: 23, page: 2, pageSize: 20 });
    expect(page.list.items).toHaveLength(3);
    expect(page.trends.roundCount).toBe(23);
    expect(page.trends.bySector).toEqual([
      {
        sector: "fintech",
        rounds: 23,
        disclosedRounds: 23,
        convertedRounds: 23,
        totalMicros: "230000000",
      },
    ]);
    expect(
      (
        await getPublishedFundingRounds(db(), { sector: "fintech", page: 1 })
      ).items.every(
        (item) => !page.list.items.some((other) => other.id === item.id),
      ),
    ).toBe(true);
  });

  it("counts by sector, stage and investor, and totals only disclosed amounts", async () => {
    await seedRound({
      status: "published",
      sector: "fintech",
      stage: "seed",
      amount: 2_000_000,
      investors: ["Alpha"],
    });
    await seedRound({
      status: "published",
      sector: "fintech",
      stage: "seed",
      amount: null,
      investors: ["alpha", "Beta"],
    });
    await seedRound({
      status: "published",
      sector: "robotics",
      stage: "series_a",
      amount: 5_000_000,
      investors: ["Beta"],
    });
    const t = await getFundingTrends(db());
    expect(t.roundCount).toBe(3);
    expect(t.bySector).toEqual([
      {
        sector: "fintech",
        rounds: 2,
        disclosedRounds: 1,
        convertedRounds: 1,
        totalMicros: "2000000000000",
      },
      {
        sector: "robotics",
        rounds: 1,
        disclosedRounds: 1,
        convertedRounds: 1,
        totalMicros: "5000000000000",
      },
    ]);
    expect(t.byStage).toEqual([
      { stage: "seed", rounds: 2 },
      { stage: "series_a", rounds: 1 },
    ]);
    expect(
      t.investorActivity.map((i) => [i.name.toLowerCase(), i.rounds]),
    ).toEqual([
      ["alpha", 2],
      ["beta", 2],
    ]);
  });

  it("lists a source only while its article is approved, and only http(s) links", async () => {
    const good = await seedArticle({
      industryId: fin.industryId,
      sourceId: fin.sourceId,
      title: "Good",
      url: "https://news.example/good",
    });
    await seedReview(good, "approved");
    const taken = await seedArticle({
      industryId: fin.industryId,
      sourceId: fin.sourceId,
      title: "Taken down",
      url: "https://news.example/taken",
    });
    await seedReview(taken, "rejected");
    const evil = await seedArticle({
      industryId: fin.industryId,
      sourceId: fin.sourceId,
      title: "Evil",
      url: "https://news.example/evil",
    });
    await seedReview(evil, "approved");
    await seedRound({
      status: "published",
      sources: [
        { articleId: good, url: "https://news.example/good", title: "Good" },
        { articleId: evil, url: "javascript:alert(1)", title: "Evil" },
      ],
    });
    const [item] = (await getPublishedFundingRounds(db())).items;
    expect(item.sources).toEqual([
      { articleId: good, url: "https://news.example/good", title: "Good" },
    ]);
    // A round that cites a revoked source is not public at all.
    await seedRound({
      status: "published",
      sources: [
        { articleId: good, url: "https://news.example/good", title: "Good" },
        {
          articleId: taken,
          url: "https://news.example/taken",
          title: "Taken down",
        },
      ],
    });
    expect((await getPublishedFundingRounds(db())).total).toBe(1);
  });

  it("carries public corrections of a round", async () => {
    const id = await seedRound({ status: "published" });
    await env.DB.prepare(
      "INSERT INTO corrections (target_type, target_id, body, created_at) VALUES ('funding_rounds', ?1, 'Funding record updated: x', 5)",
    )
      .bind(id)
      .run();
    const [item] = (await getPublishedFundingRounds(db())).items;
    expect(item.corrections).toEqual([
      { body: "Funding record updated: x", createdAt: 5 },
    ]);
  });

  it("the page view carries the Finance disclaimer and has no rating fields", async () => {
    await seedRound({ status: "published", investors: ["Alpha"] });
    const page = await getFundingPage(db());
    expect(page.disclaimer).toBe(DISCLAIMER);
    const json = JSON.stringify(page);
    expect(json).not.toMatch(/rating|rank|score|buy|sell|hold/i);
  });

  it("falls back to a disclaimer when the Finance section has none", async () => {
    await env.DB.prepare("UPDATE industries SET disclaimer = NULL").run();
    expect((await getFundingPage(db())).disclaimer).toContain(
      "Not investment advice",
    );
  });
});
