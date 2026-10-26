import { describe, expect, it } from "vitest";
import { parseRobots, robotsFromResponse } from "../../src/lib/robots";

const UA = "DailyBot";

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

  it("a ClaudeBot-only group does not apply: DailyBot uses *", () => {
    const r = parseRobots(
      "User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n",
      UA,
    );
    expect(r.allowed("/news/1")).toBe(true);
    expect(r.allowed("/private/x")).toBe(false);
  });

  it("our group, matched case-insensitively, replaces *", () => {
    const r = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: dailybot\nUser-agent: other\nDisallow: /x\nCrawl-delay: 15\n",
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

  it("compares percent-escapes per RFC 9309 2.2.2: unreserved decoded, others upper case", () => {
    const plain = parseRobots("User-agent: *\nDisallow: /admin\n", UA);
    expect(plain.allowed("/%61dmin")).toBe(false);
    expect(plain.allowed("/%61DMIN")).toBe(true);
    const escaped = parseRobots("User-agent: *\nDisallow: /%61dmin\n", UA);
    expect(escaped.allowed("/admin")).toBe(false);
    const tilde = parseRobots("User-agent: *\nDisallow: /%7euser\n", UA);
    expect(tilde.allowed("/~user")).toBe(false);
    expect(
      parseRobots("User-agent: *\nDisallow: /~u\n", UA).allowed("/%7Eu"),
    ).toBe(false);
    // %2F is reserved: it stays an escape, it is not "/".
    const slash = parseRobots("User-agent: *\nDisallow: /a%2fb\n", UA);
    expect(slash.allowed("/a%2Fb")).toBe(false);
    expect(slash.allowed("/a/b")).toBe(true);
    expect(
      parseRobots("User-agent: *\nDisallow: /a/b\n", UA).allowed("/a%2Fb"),
    ).toBe(true);
    // Non-ASCII is compared as UTF-8 escapes.
    const cjk = parseRobots("User-agent: *\nDisallow: /\u4e2d\n", UA);
    expect(cjk.allowed("/%E4%B8%AD")).toBe(false);
    expect(cjk.allowed("/%e4%b8%ad")).toBe(false);
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
