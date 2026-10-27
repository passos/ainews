import { describe, expect, it } from "vitest";
import {
  CLAIMS_PROMPT_VERSION,
  buildClaimsExtractionRequest,
  type EventEvidenceInput,
} from "../../src/pipeline/evidence/prompts";

// Guard (#140): the claims-extraction request bytes must not change when the
// parse-failure log changes. If they do, the prompt version and ledger keys
// move and every event is re-extracted at real cost.
const EXPECTED_REQUEST_SHA256 =
  "17ff4dbaefabe70a5bdbbc82d42ae2fde30dae47eba81facf666ce63c1a52431";

const MATERIAL: EventEvidenceInput = {
  eventId: 140,
  eventTitle: "Fixture event",
  industryName: "Fixture",
  disclaimer: "Fixture disclaimer.",
  articles: [
    {
      id: 1,
      title: "Fixture article",
      sourceName: "Fixture Source",
      sourceDomain: "fixture.test",
      bodySha: "sha-fixture",
      isPrimarySource: true,
      bodyText: "Fixture body.",
    },
    {
      id: 2,
      title: "Second article",
      sourceName: "Other Source",
      sourceDomain: "other.test",
      bodySha: "sha-other",
      isPrimarySource: false,
      bodyText: "Second body.",
    },
  ],
};

describe("claims extraction request bytes (#140)", () => {
  it("serialises to the pinned bytes, with and without a disclaimer", async () => {
    const sites = [MATERIAL, { ...MATERIAL, disclaimer: null }].map((m) => ({
      promptVersion: CLAIMS_PROMPT_VERSION,
      request: buildClaimsExtractionRequest(m),
    }));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(sites)),
    );
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe(EXPECTED_REQUEST_SHA256);
  });
});
