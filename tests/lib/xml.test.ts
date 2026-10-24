import { describe, expect, it } from "vitest";
import { escapeXml } from "../../src/lib/xml";

describe("escapeXml", () => {
  it("escapes the five XML characters", () => {
    expect(escapeXml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;",
    );
  });

  it("escapes & first, so entities are not double-escaped wrongly", () => {
    expect(escapeXml("&lt;")).toBe("&amp;lt;");
  });

  it("removes characters that XML 1.0 forbids", () => {
    expect(escapeXml("a\u0000b\u0008c\u000bd￾e￿f")).toBe("abcdef");
    expect(escapeXml("tab\tnewline\ncr\r")).toBe("tab\tnewline\ncr\r");
  });
});
