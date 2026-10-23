import { describe, expect, it } from "vitest";
import {
  TransportHttpError,
  restTransport,
} from "../../src/providers/transport";
import { fakeFetch } from "./fakes";

const OPTIONS = { accountId: "acct", token: "tok-123", gatewayId: "gw" };

describe("restTransport", () => {
  it("posts to /ai/run/{model} with the token and gateway headers", async () => {
    const fake = fakeFetch(() =>
      Response.json({ success: true, errors: [], result: { ok: 1 } }),
    );
    const transport = restTransport({ ...OPTIONS, fetch: fake.fetch });

    await expect(
      transport.run("google/gemini-3.8-flash", { a: 1 }),
    ).resolves.toEqual({ ok: 1 });

    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/google/gemini-3.8-flash",
    );
    expect(request.headers.get("authorization")).toBe("Bearer tok-123");
    expect(request.headers.get("cf-aig-gateway-id")).toBe("gw");
    expect(await request.json()).toEqual({ a: 1 });
  });

  it("returns a body without the API envelope as is", async () => {
    const fake = fakeFetch(() => Response.json({ candidates: [] }));
    const transport = restTransport({ ...OPTIONS, fetch: fake.fetch });
    await expect(transport.run("google/x", {})).resolves.toEqual({
      candidates: [],
    });
  });

  it("throws TransportHttpError on a non-2xx status", async () => {
    const fake = fakeFetch(() => new Response("rate limited", { status: 429 }));
    const transport = restTransport({ ...OPTIONS, fetch: fake.fetch });

    const error = await transport.run("google/x", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportHttpError);
    expect(error).toMatchObject({ status: 429, body: "rate limited" });
  });
});
