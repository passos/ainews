import { describe, expect, it } from "vitest";
import { isApprovedReview } from "../../src/lib/approved-review";

describe("isApprovedReview", () => {
  it("is true for an approval of the current body", () => {
    const review = { bodySha: "abc", decision: "approved" };
    expect(isApprovedReview(review, "abc")).toBe(true);
  });

  it("is false for an approval of an older body", () => {
    const review = { bodySha: "abc", decision: "approved" };
    expect(isApprovedReview(review, "def")).toBe(false);
  });

  it("is false for a rejection of the current body", () => {
    const review = { bodySha: "abc", decision: "rejected" };
    expect(isApprovedReview(review, "abc")).toBe(false);
  });

  it("is false when the article has no body sha", () => {
    // reviews.body_sha is NOT NULL; articles.body_sha is nullable.
    const review = { bodySha: "abc", decision: "approved" };
    expect(isApprovedReview(review, null)).toBe(false);
    expect(isApprovedReview(review, undefined)).toBe(false);
  });
});
