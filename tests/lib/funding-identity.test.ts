import { describe, expect, it } from "vitest";
import {
  buildFundingRequest,
  parseFundingOutput,
} from "../../src/pipeline/funding/prompts";

describe("funding v2 protocol", () => {
  it("rejects flat v1 answers rather than silently upgrading evidence", () => {
    expect(
      parseFundingOutput(
        JSON.stringify({
          rounds: [
            {
              isFundingAnnouncement: true,
              companyName: "Acme",
              roundName: "Seed",
            },
          ],
        }),
      ),
    ).toBeNull();
  });
  it.each([11999, 12000, 12001, 18000])(
    "sends the bounded excerpt with explicit coverage for %i characters",
    (length) => {
      const body = "x".repeat(length);
      const request = buildFundingRequest({
        id: 1,
        title: "Funding",
        url: "https://news.example/1",
        publishedAt: "2026-10-20",
        body,
      });
      expect(request.maxOutputTokens).toBe(8000);
      expect(request.thinkingConfig).toEqual({ thinkingLevel: "low" });
      const material = JSON.parse(
        request.prompt.slice(request.prompt.indexOf("{")),
      );
      expect(material.body).toBe(body.slice(0, 12000));
      expect(material.bodyIsExcerpt).toBe(length > 12000);
      expect(material.originalBodyChars).toBe(length);
    },
  );
});

import {
  applyFundingPatch,
  automaticFundingIdentity,
  concreteFundingRound,
  parseAnnouncementDate,
} from "../../src/lib/funding/identity";
import {
  extractedRoundSchema,
  fundingPatchSchema,
  type FundingFacts,
} from "../../src/lib/funding/types";
const facts: FundingFacts = {
  companyName: "Acme",
  roundName: "Seed",
  amount: 10,
  currency: "USD",
  valuation: 100,
  sector: "fintech",
  stage: "seed",
  announcedDate: "2026-10-19",
  investors: ["Alpha", "Beta"],
  leadInvestors: ["Alpha"],
};
const evidence = {
  quote: "The amount is withdrawn; Beta leaves; Gamma joins.",
};
it("keeps omitted fields and applies only evidenced scalar patches", () => {
  expect(applyFundingPatch(facts, {}, evidence.quote)).toEqual(facts);
  expect(
    applyFundingPatch(
      facts,
      { amount: { op: "clear", evidence } },
      evidence.quote,
    ),
  ).toMatchObject({ amount: null, valuation: 100 });
  expect(() =>
    applyFundingPatch(
      facts,
      { amount: { op: "set", value: 12, evidence } },
      "different body",
    ),
  ).toThrow(/evidence/);
  expect(
    fundingPatchSchema.safeParse({ currency: { op: "clear", evidence } })
      .success,
  ).toBe(false);
});
it("distinguishes investor additions removals and full replacement", () => {
  expect(
    applyFundingPatch(facts, {
      investors: { op: "delta", add: ["Gamma"], remove: ["Beta"], evidence },
    }).investors,
  ).toEqual(["Alpha", "Gamma"]);
  expect(
    applyFundingPatch(facts, {
      investors: { op: "replace", values: [], evidence },
    }).investors,
  ).toEqual([]);
  expect(
    fundingPatchSchema.safeParse({
      investors: { op: "delta", add: ["Alpha"], remove: ["ALPHA"], evidence },
    }).success,
  ).toBe(false);
});
it.each(["2026-02-30", "2026-10", "yesterday", "10/11/2026", ""])(
  "does not guess announcement date %s",
  (value) => expect(parseAnnouncementDate(value)).toBeNull(),
);
it("validates complete English calendar dates", () => {
  expect(parseAnnouncementDate("October 19th, 2026")).toBe("2026-10-19");
  expect(parseAnnouncementDate("19 Oct 2026")).toBe("2026-10-19");
  expect(parseAnnouncementDate("29 February 2025")).toBeNull();
});
it("separates concrete rounds from stage buckets", () => {
  const labels = [
    "Pre-Series A",
    "Series A",
    "Series D",
    "Series E",
    "Growth",
    "Strategic",
    "Seed",
    "Seed extension",
  ];
  expect(new Set(labels.map(concreteFundingRound)).size).toBe(labels.length);
});
it("keeps a missing host as an unresolved candidate without rejecting its payload", () => {
  const field = (value: string) => ({ value, evidence: { quote: value } });
  const round = extractedRoundSchema.parse({
    identity: {
      companyName: field("Acme"),
      roundName: field("Seed"),
      companyHost: null,
      announcedDate: null,
      sameEventEvidence: null,
    },
    reportedFacts: {},
    correctionPatch: {},
    correctionReason: null,
  });
  expect(automaticFundingIdentity(round)).toBeNull();
});

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
it("keeps at most one published and one pending version per round (migration 0020)", () => {
  const dir = new URL("../../drizzle/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((name) => /^002\d_.*\.sql$/.test(name));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^0020_/);
  const migration = readFileSync(new URL(files[0], dir), "utf8");
  expect(migration).not.toMatch(/DROP (TABLE|INDEX)/i);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE articles(id INTEGER PRIMARY KEY)",
    );
    db.exec(migration.replaceAll("--> statement-breakpoint", ""));
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='funding_rounds' AND name LIKE '%unique%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(names).toEqual([
      "funding_rounds_pending_unique",
      "funding_rounds_published_unique",
    ]);
    const insert = db.prepare(
      "INSERT INTO funding_rounds(company_name,company_key,round_name,round_key,currency,sector,stage,source_url,status,superseded_by,created_at,updated_at) VALUES ('Acme','entity:acme','Seed','event:seed:2026-10-19','USD','fintech','seed','https://news.example',?,?,0,0)",
    );
    insert.run("published", null);
    insert.run("pending_review", null);
    insert.run("rejected", null);
    insert.run("rejected", null);
    insert.run("published", 1);
    expect(() => insert.run("pending_review", null)).toThrow(/UNIQUE/);
    expect(() => insert.run("published", null)).toThrow(/UNIQUE/);
  } finally {
    db.close();
  }
});
it("uses concrete labels rather than stage buckets in automatic event identity", () => {
  const field = (value: string) => ({ value, evidence: { quote: value } });
  const keys = [
    "Pre-Series A",
    "Series A",
    "Series D",
    "Series E",
    "Seed",
    "Seed extension",
    "Growth",
    "Strategic",
  ].map((label) => {
    const round = extractedRoundSchema.parse({
      identity: {
        companyName: field("Acme"),
        roundName: field(label),
        companyHost: field("https://acme.example"),
        announcedDate: field("2026-10-19"),
        sameEventEvidence: null,
      },
      reportedFacts: {},
      correctionPatch: {},
      correctionReason: null,
    });
    return automaticFundingIdentity(round)!.roundKey;
  });
  expect(new Set(keys).size).toBe(keys.length);
});
it("keys automatic identity by company name, concrete round and date, with the host only as evidence", () => {
  const field = (value: string) => ({ value, evidence: { quote: value } });
  const make = (host: string | null) =>
    extractedRoundSchema.parse({
      identity: {
        companyName: field("Acme"),
        roundName: field("Series A"),
        companyHost: host ? field(host) : null,
        announcedDate: field("2026-10-19"),
        sameEventEvidence: null,
      },
      reportedFacts: {},
      correctionPatch: {},
      correctionReason: null,
    });
  const without = automaticFundingIdentity(make(null));
  expect(without).toMatchObject({
    companyKey: "entity:acme",
    roundKey: "event:series_a:2026-10-19",
    companyHost: null,
  });
  expect(
    automaticFundingIdentity(make("https://www.acme.example")),
  ).toMatchObject({
    companyKey: without!.companyKey,
    roundKey: without!.roundKey,
    companyHost: "acme.example",
  });
});
