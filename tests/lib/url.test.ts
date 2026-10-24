import { describe, expect, it } from "vitest";
import { normalizeUrl, safeHttpUrl } from "../../src/lib/url";

describe("normalizeUrl", () => {
  it("lowercases the host, drops www., tracking params, fragment and trailing slash, sorts params", () => {
    expect(
      normalizeUrl("https://www.Example.com/a/?utm_source=x&b=2&a=1#f"),
    ).toBe("https://example.com/a?a=1&b=2");
  });

  it("returns null for a non-http(s) URL or garbage", () => {
    expect(normalizeUrl("ftp://x")).toBeNull();
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("makes http and https, default ports, and www. the same", () => {
    const forms = [
      "http://example.com/p",
      "https://example.com/p/",
      "http://www.example.com:80/p",
      "https://example.com:443/p#top",
    ];
    expect(new Set(forms.map(normalizeUrl))).toEqual(
      new Set(["https://example.com/p"]),
    );
  });

  it("removes every listed tracking parameter and keeps the others", () => {
    const tracking = [
      "utm_medium=a",
      "UTM_Campaign=b",
      "fbclid=c",
      "gclid=d",
      "mc_cid=e",
      "mc_eid=f",
      "ref_src=h",
      "_hsenc=i",
      "_hsmi=j",
      "igshid=k",
      "mkt_tok=l",
      "spm=m",
    ].join("&");
    expect(normalizeUrl(`https://x.com/a?id=7&${tracking}`)).toBe(
      "https://x.com/a?id=7",
    );
  });

  it("keeps ref (some sites use it to tell articles apart), drops ref_src", () => {
    const a = normalizeUrl("https://x.com/p?ref=a&ref_src=twsrc");
    const b = normalizeUrl("https://x.com/p?ref=b");
    expect(a).toBe("https://x.com/p?ref=a");
    expect(a).not.toBe(b);
  });

  it("keeps the root path and a non-default port", () => {
    expect(normalizeUrl("https://x.com/")).toBe("https://x.com/");
    expect(normalizeUrl("https://x.com:8443/a/")).toBe("https://x.com:8443/a");
  });

  it("trims the path's trailing slash, not the query's", () => {
    expect(normalizeUrl("https://x.com/a/?q=b/")).toBe(
      "https://x.com/a?q=b%2F",
    );
  });
});

describe("safeHttpUrl", () => {
  it("keeps http and https URLs as given", () => {
    expect(safeHttpUrl("https://x.com/a?b=1")).toBe("https://x.com/a?b=1");
    expect(safeHttpUrl("http://x.com/")).toBe("http://x.com/");
  });

  it("returns null for any other scheme or garbage", () => {
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<script>1</script>",
      "ftp://x.com",
      "//x.com/a",
      "not a url",
      "",
    ]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});
