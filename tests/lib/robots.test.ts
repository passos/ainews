import { describe, expect, it } from "vitest";
import { parseRobots, robotsFromResponse } from "../../src/lib/robots";

const UA = "PersonalNewsBot";

describe("parseRobots (RFC 9309)", () => {
  it("longest match wins: Disallow /a + Allow /a/b", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b\n", UA);
    expect(r.allowed("/a/b/c")).toBe(true);
    expect(r.allowed("/a/x")).toBe(false);
    expect(r.allowed("/b")).toBe(true);
  });

  it("a tie goes to Allow", () => {
    const r = parseRobots("User-agent: *\nDisallow: /p\nAllow: /p\n", UA);
    expect(r.allowed("/p")).toBe(true);
  });

  it("a ClaudeBot-only group does not apply: PersonalNewsBot uses *", () => {
    const r = parseRobots(
      "User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n",
      UA,
    );
    expect(r.allowed("/news/1")).toBe(true);
    expect(r.allowed("/private/x")).toBe(false);
  });

  it("our group, matched case-insensitively, replaces *", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: personalnewsbot\nUser-agent: other\nDisallow: /x\nCrawl-delay: 15\n",
      UA,
    );
    expect(r.allowed("/news")).toBe(true);
    expect(r.allowed("/x/1")).toBe(false);
    expect(r.crawlDelaySec).toBe(15);
  });

  it("supports * and $, comments, and an empty Disallow", () => {
    const r = parseRobots(
      "# c\nUser-agent: * # all\nDisallow: /*.pdf$\nDisallow: /tmp*/x\nDisallow:\n",
      UA,
    );
    expect(r.allowed("/a/b.pdf")).toBe(false);
    expect(r.allowed("/a/b.pdf?x=1")).toBe(true);
    expect(r.allowed("/tmp123/x")).toBe(false);
    expect(r.allowed("/t")).toBe(true);
    expect(r.crawlDelaySec).toBeNull();
  });

  it("matches the query string and treats regex characters literally", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /s?q=\nDisallow: /a.b\n",
      UA,
    );
    expect(r.allowed("/s?q=1")).toBe(false);
    expect(r.allowed("/s")).toBe(true);
    expect(r.allowed("/axb")).toBe(true);
    expect(r.allowed("/a.b")).toBe(false);
  });

  it("no group at all allows everything", () => {
    expect(parseRobots("Disallow: /\n", UA).allowed("/a")).toBe(true);
    expect(parseRobots("", UA).allowed("/a")).toBe(true);
  });
});

describe("robotsFromResponse", () => {
  it("404 allows everything", () => {
    expect(robotsFromResponse(404, null, UA).allowed("/a")).toBe(true);
  });

  it("503, 429 and a network error (0) disallow everything", () => {
    for (const status of [503, 500, 429, 0]) {
      expect(robotsFromResponse(status, null, UA).allowed("/a")).toBe(false);
    }
  });

  it("200 uses the body", () => {
    const r = robotsFromResponse(200, "User-agent: *\nDisallow: /a\n", UA);
    expect(r.allowed("/a")).toBe(false);
    expect(r.allowed("/b")).toBe(true);
  });
});
