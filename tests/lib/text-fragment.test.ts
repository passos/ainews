import { describe, expect, it } from "vitest";
import {
  originalFragmentHref,
  textFragmentHref,
} from "../../src/lib/text-fragment";

describe("textFragmentHref", () => {
  it("links a short quote whole", () => {
    expect(textFragmentHref(7, "short quote here")).toBe(
      "/a/7#:~:text=short%20quote%20here",
    );
  });

  it("links a long quote as a start,end range of 4 words each", () => {
    const quote =
      "one two three four five six seven eight nine ten eleven twelve";
    const href = textFragmentHref(7, quote);
    expect(href).toBe(
      "/a/7#:~:text=one%20two%20three%20four,nine%20ten%20eleven%20twelve",
    );
    expect(href.split(",")).toHaveLength(2);
  });

  it("encodes '-', ',' and '&', which are directive syntax", () => {
    const href = textFragmentHref(7, "state-of-the-art, fast & cheap");
    const fragment = href.slice("/a/7".length);
    expect(fragment).toContain("%2D");
    expect(fragment).not.toContain("-");
    expect(fragment).toContain("%2C");
    expect(fragment).toContain("%26");
  });

  it("strips markdown marks", () => {
    expect(textFragmentHref(7, "**bold** and [link](https://x.y) text")).toBe(
      "/a/7#:~:text=bold%20and%20link%20text",
    );
  });

  it("keeps an underscore inside a word", () => {
    expect(textFragmentHref(7, "snake_case stays")).toBe(
      "/a/7#:~:text=snake_case%20stays",
    );
  });

  it("links the page alone when only marks remain", () => {
    expect(textFragmentHref(7, "**")).toBe("/a/7");
  });
});

describe("originalFragmentHref", () => {
  it("adds a text directive to the original URL", () => {
    expect(originalFragmentHref("https://n.example/a", "short quote")).toBe(
      "https://n.example/a#:~:text=short%20quote",
    );
  });

  it("appends to an existing fragment instead of adding a second '#'", () => {
    expect(originalFragmentHref("https://n.example/a#top", "short quote")).toBe(
      "https://n.example/a#top:~:text=short%20quote",
    );
  });

  it("returns the URL unchanged when only marks remain", () => {
    expect(originalFragmentHref("https://n.example/a", "**")).toBe(
      "https://n.example/a",
    );
  });
});
