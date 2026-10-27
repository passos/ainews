import { afterEach, describe, expect, it, vi } from "vitest";
import { toResponse } from "../../src/server/reader-ask/api";
import { ReaderAskError } from "../../src/server/reader-ask/errors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toResponse", () => {
  it("maps a ReaderAskError to its status and code", async () => {
    const res = toResponse(new ReaderAskError("daily_limit", 429));
    expect(res).toBeInstanceOf(Response);
    const r = res as Response;
    expect(r.status).toBe(429);
    expect(r.headers.get("Content-Type")).toBe("application/json");
    expect(await r.json()).toEqual({ error: "daily_limit" });
  });

  it("hides any other error behind a 500 internal response and logs it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new Error(
      "D1_ERROR: no such table: secret_tbl_xyz: SQLITE_ERROR",
    );
    const res = toResponse(original);
    expect(res).toBeInstanceOf(Response);
    const r = res as Response;
    expect(r.status).toBe(500);
    expect(r.headers.get("Content-Type")).toBe("application/json");
    const body = await r.text();
    expect(body).not.toContain("secret_tbl_xyz");
    expect(JSON.parse(body)).toEqual({ error: "internal" });
    expect(logged).toHaveBeenCalled();
    expect(logged.mock.calls.flat()).toContain(original);
  });
});
