import { describe, expect, it } from "vitest";
import { describeError } from "../src/components/admin/errors";

// #87 A4: a Response thrown by an admin server function used to print as
// "[object Response]". The page now shows its body.
describe("describeError", () => {
  it("reads the body of a Response", async () => {
    const err = new Response("Source has 3 articles - pause it instead", {
      status: 409,
    });
    expect(await describeError(err)).toBe(
      "Source has 3 articles - pause it instead",
    );
  });

  it("falls back to the status when the body is empty", async () => {
    expect(await describeError(new Response("", { status: 500 }))).toBe(
      "Request failed (500)",
    );
  });

  it("uses Error messages and stringifies the rest", async () => {
    expect(await describeError(new Error("boom"))).toBe("boom");
    expect(await describeError("odd")).toBe("odd");
  });
});
