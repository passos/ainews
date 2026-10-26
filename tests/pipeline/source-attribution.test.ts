import { describe, expect, it } from "vitest";
import {
  documentHost,
  readerSourceName,
} from "../../src/pipeline/source-attribution";

describe("source attribution", () => {
  it("documentHost lower-cases and drops www.", () => {
    expect(documentHost("https://WWW.SEC.gov/doc")).toBe("sec.gov");
    expect(documentHost("https://data.sec.gov/x")).toBe("data.sec.gov");
  });

  it("documentHost falls back to 'unknown' for an invalid or host-less URL", () => {
    expect(documentHost("not a url")).toBe("unknown");
    expect(documentHost("mailto:someone@example.com")).toBe("unknown");
  });

  it("readerSourceName shows the host only for system sources", () => {
    expect(
      readerSourceName(
        "Primary documents (system)",
        "system:primary-documents",
        "https://www.nasa.gov/report",
      ),
    ).toBe("nasa.gov");
    expect(
      readerSourceName("Tech Wire", "https://tech/feed", "https://nasa.gov/r"),
    ).toBe("Tech Wire");
  });
});
