import { describe, expect, it } from "vitest";
import {
  LEARNING_MATERIAL_PROMPT_VERSION,
  type ArtifactEventMaterial,
} from "../../src/pipeline/artifacts/prompts";
import { ARTIFACT_REGISTRY } from "../../src/pipeline/artifacts/registry";

// Guard (#126): the request bytes of every artifact request site must not
// change when parsers or schemas change. If they do, prompt versions and
// ledger keys move and every event is regenerated at real cost.
const EXPECTED_REQUEST_SHA256 =
  "c4a27a9b82babc256b9ef69a53f6064f206de8e74c2578c4ffabe4437e558f42";

const MATERIAL: ArtifactEventMaterial = {
  eventId: 126,
  eventTitle: "Fixture event",
  industryName: "Fixture",
  industrySlug: "finance",
  disclaimer: "Fixture disclaimer.",
  articles: [
    {
      id: 1,
      title: "Fixture article",
      sourceName: "Fixture Source",
      sourceDomain: "fixture.test",
      publishedAt: 1000,
      summary: "Fixture summary.",
      bodyText: "Fixture body.",
    },
  ],
  verifiedClaims: [
    {
      id: 2,
      claimText: "Fixture claim.",
      claimType: "metric",
      consensusStatus: "verified",
      realityCheck: "Fixture reality.",
    },
  ],
  financialFacts: [
    {
      id: 3,
      taxonomy: "us-gaap",
      concept: "Revenues",
      unit: "USD",
      val: "100",
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      fiscalYear: 2026,
      fiscalPeriod: "Q1",
      secUrl: "https://www.sec.gov/fixture",
    },
  ],
  filing: {
    id: 4,
    accessionNumber: "0000000000-26-000001",
    form: "10-Q",
    filingDate: "2026-04-30",
    reportDate: "2026-03-31",
    secUrl: "https://www.sec.gov/fixture",
    fiscalYear: 2026,
    fiscalPeriod: "Q1",
    companyTicker: "FIX",
    companyName: "Fixture Inc",
    companyCik: "0000000001",
  },
  calculatedMetrics: [
    {
      metricName: "Revenue",
      concept: "Revenues",
      unit: "USD",
      reportedValue: "100",
      reportedCitation: { factId: 3, secUrl: "https://www.sec.gov/fixture" },
      priorPeriodValue: "90",
      priorYearValue: "80",
      guidanceComparison: "above",
      deltaQoQPercent: "11.1%",
      deltaYoYPercent: "25.0%",
    },
  ],
};

describe("artifact request bytes (#126)", () => {
  it("every request site serialises to the pinned bytes", async () => {
    const sites = Object.values(ARTIFACT_REGISTRY).flatMap((def) =>
      def.audiences.map((aud) => ({
        type: def.type,
        audience: aud,
        slot: def.slot ?? "write",
        promptVersion: def.promptVersion,
        request: def.buildRequest(MATERIAL, aud),
      })),
    );
    expect(sites).toHaveLength(18);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(sites)),
    );
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(EXPECTED_REQUEST_SHA256);
  });

  it("the learning_material prompt version is unchanged", () => {
    expect(LEARNING_MATERIAL_PROMPT_VERSION).toBe("learning-material-v1");
  });
});
