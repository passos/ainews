import { describe, expect, it } from "vitest";
import {
  attributeSource,
  documentHost,
  isSystemSource,
  readerSourceName,
} from "../../src/lib/source-attribution";

describe("source attribution", () => {
  it.each([
    ["upper case", "HTTPS://WWW.SEC.GOV/doc", "sec.gov"],
    ["www.", "https://www.nasa.gov/report", "nasa.gov"],
    ["subdomain kept", "https://data.sec.gov/x", "data.sec.gov"],
    ["port dropped", "https://www.nasa.gov:8443/x", "nasa.gov"],
    ["userinfo dropped", "https://user:pw@www.nasa.gov/x", "nasa.gov"],
    ["empty string", "", "unknown"],
    ["not a URL", "not a url", "unknown"],
    ["mailto has no host", "mailto:someone@example.com", "unknown"],
    ["ftp host", "ftp://ftp.example.org/file.txt", "ftp.example.org"],
  ])("documentHost: %s", (_case, url, host) => {
    expect(documentHost(url)).toBe(host);
  });

  // Same match as SQL `feed_url LIKE 'system:%'` and assertNotSystemFeed.
  it.each([
    ["lower case", "system:x", true],
    ["upper case", "SYSTEM:x", true],
    ["mixed case", "System:x", true],
    ["leading whitespace", "  system:x", true],
    ["system: inside a URL", "https://system:x", false],
    ["prefix before system:", "xsystem:", false],
    ["real feed", "https://techwire.com/feed", false],
  ])("isSystemSource: %s", (_case, feedUrl, expected) => {
    expect(isSystemSource(feedUrl)).toBe(expected);
  });

  const DOC = "https://user:pw@WWW.NASA.gov:8443/report";
  it.each([
    [
      "system source shows the host",
      {
        name: "Primary documents (system)",
        siteDomain: null,
        feedUrl: "system:primary-documents",
      },
      { name: "nasa.gov", domain: "nasa.gov" },
    ],
    [
      "system source ignores its site_domain",
      {
        name: "System mirror",
        siteDomain: "mirror.example",
        feedUrl: "system:other",
      },
      { name: "nasa.gov", domain: "nasa.gov" },
    ],
    [
      "NULL site_domain: name kept, domain from host",
      {
        name: "Lab Notes",
        siteDomain: null,
        feedUrl: "https://lab.example/feed",
      },
      { name: "Lab Notes", domain: "nasa.gov" },
    ],
    [
      "empty site_domain: name kept, domain from host",
      {
        name: "Lab Notes",
        siteDomain: "",
        feedUrl: "https://lab.example/feed",
      },
      { name: "Lab Notes", domain: "nasa.gov" },
    ],
    [
      "real source unchanged",
      {
        name: "Tech Wire",
        siteDomain: "techwire.com",
        feedUrl: "https://techwire.com/feed",
      },
      { name: "Tech Wire", domain: "techwire.com" },
    ],
  ])("attributeSource: %s", (_case, source, expected) => {
    expect(attributeSource({ ...source, canonicalUrl: DOC })).toEqual(expected);
  });

  it("readerSourceName shows the host only for system sources", () => {
    expect(
      readerSourceName(
        "Primary documents (system)",
        "system:primary-documents",
        DOC,
      ),
    ).toBe("nasa.gov");
    expect(readerSourceName("Tech Wire", "https://tech/feed", DOC)).toBe(
      "Tech Wire",
    );
  });
});
