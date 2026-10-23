import { describe, expect, it } from "vitest";
import { jinaTransport, parseJinaText } from "../../src/providers/jina";
import {
  prefixTransport,
  TransportHttpError,
} from "../../src/providers/transport";
import { fakeFetch } from "./fakes";

describe("parseJinaText", () => {
  it("returns the part after Markdown Content:", () => {
    expect(
      parseJinaText(
        "Title: A\nURL Source: u\n\nMarkdown Content:\n# A\n\nbody",
      ),
    ).toBe("# A\n\nbody");
  });

  it("returns null when the head reports a target error or a CAPTCHA", () => {
    expect(
      parseJinaText(
        "Title: A\nWarning: Target URL returned error 404: Not Found\nMarkdown Content:\nx",
      ),
    ).toBeNull();
    expect(
      parseJinaText(
        "Title: A\nWarning: CAPTCHA required\nMarkdown Content:\nx",
      ),
    ).toBeNull();
  });

  it("an error word in the content itself is not a failure", () => {
    expect(parseJinaText("Title: A\nMarkdown Content:\nabout CAPTCHA")).toBe(
      "about CAPTCHA",
    );
  });
});

describe("jinaTransport", () => {
  it("returns text, x-usage-tokens and truncated; HTTP errors throw", async () => {
    const ok = fakeFetch(
      () =>
        new Response("Markdown Content:\nx", {
          headers: { "x-usage-tokens": "12" },
        }),
    );
    const t = jinaTransport({ apiKey: "k", fetch: ok.fetch });
    expect(await t.run("jina/reader", { url: "https://a.example/p" })).toEqual({
      text: "Markdown Content:\nx",
      usageTokens: 12,
      truncated: false,
    });
    const bad = fakeFetch(() => new Response("no", { status: 402 }));
    await expect(
      jinaTransport({ apiKey: "k", fetch: bad.fetch }).run("jina/reader", {
        url: "https://a.example/p",
      }),
    ).rejects.toThrow(TransportHttpError);
  });

  it("refuses an empty key before any request", () => {
    expect(() => jinaTransport({ apiKey: "" })).toThrow();
  });
});

describe("prefixTransport", () => {
  it("routes by model prefix and rejects unknown models", async () => {
    const seen: string[] = [];
    const t = prefixTransport({
      "jina/": { run: async (m) => seen.push(`jina ${m}`) },
    });
    await t.run("jina/reader", {});
    expect(seen).toEqual(["jina jina/reader"]);
    await expect(t.run("google/x", {})).rejects.toThrow(/no transport/);
  });
});
