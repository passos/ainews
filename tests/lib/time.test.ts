// Runs in the node project under TZ=UTC and TZ=Asia/Shanghai (npm run
// test:tz). The expected values are fixed UTC instants, so a result that
// depends on the machine's time zone fails in one of the two runs.
import { describe, expect, it } from "vitest";
import { parseFeedDate } from "../../src/lib/time";

const iso = (raw: string, offset = "+00:00") =>
  parseFeedDate(raw, offset)?.toISOString() ?? null;

describe("the time zone of this run", () => {
  it("is the one test:tz set", () => {
    // Proves the TZ variable reached the process; otherwise the two runs
    // would be the same run twice.
    const offset = new Date(Date.UTC(2026, 9, 22)).getTimezoneOffset();
    if (process.env.TZ === "UTC") expect(offset).toBe(0);
    if (process.env.TZ === "Asia/Shanghai") expect(offset).toBe(-480);
  });
});

describe("parseFeedDate", () => {
  it("uses the source offset for a date without a zone", () => {
    expect(iso("2026-10-22 10:00", "+08:00")).toBe("2026-10-22T02:00:00.000Z");
    expect(iso("2026-10-22T10:00:00", "-05:30")).toBe(
      "2026-10-22T15:30:00.000Z",
    );
  });

  it("ignores the source offset when the date has a zone", () => {
    expect(iso("Thu, 22 Oct 2026 00:00:00 -0400", "+08:00")).toBe(
      "2026-10-22T04:00:00.000Z",
    );
    expect(iso("2026-10-22T10:00:00Z", "+08:00")).toBe(
      "2026-10-22T10:00:00.000Z",
    );
    expect(iso("2026-10-22T10:00:00.250+02:00", "+08:00")).toBe(
      "2026-10-22T08:00:00.250Z",
    );
  });

  it("reads a date-only string as midnight in the source zone", () => {
    expect(iso("2026-10-22", "+00:00")).toBe("2026-10-22T00:00:00.000Z");
    expect(iso("2026-10-22", "+08:00")).toBe("2026-10-21T16:00:00.000Z");
  });

  it("reads month-day-year list page dates in the source zone", () => {
    expect(iso("Oct 14, 2026")).toBe("2026-10-14T00:00:00.000Z");
    expect(iso("October 14, 2026", "+09:00")).toBe("2026-10-13T15:00:00.000Z");
  });

  it("knows the RFC 822 zone names (US meaning)", () => {
    expect(iso("Thu, 22 Oct 2026 10:00:00 GMT", "+08:00")).toBe(
      "2026-10-22T10:00:00.000Z",
    );
    expect(iso("22 Oct 2026 10:00 UT", "+08:00")).toBe(
      "2026-10-22T10:00:00.000Z",
    );
    expect(iso("Thu, 22 Oct 2026 10:00:00 UTC", "+08:00")).toBe(
      "2026-10-22T10:00:00.000Z",
    );
    const zones: [string, number][] = [
      ["EST", -5],
      ["EDT", -4],
      ["CST", -6],
      ["CDT", -5],
      ["MST", -7],
      ["MDT", -6],
      ["PST", -8],
      ["PDT", -7],
    ];
    for (const [zone, hours] of zones) {
      expect(
        parseFeedDate(`Thu, 22 Oct 2026 10:00:00 ${zone}`, "+08:00")?.getTime(),
      ).toBe(Date.UTC(2026, 9, 22, 10 - hours));
    }
  });

  it("reads an RFC 822 date without a zone in the source zone", () => {
    expect(iso("Thu, 22 Oct 2026 10:00:00", "+08:00")).toBe(
      "2026-10-22T02:00:00.000Z",
    );
    expect(iso("22 Oct 26 10:00 +0000")).toBe("2026-10-22T10:00:00.000Z");
  });

  it("returns null for what it cannot read", () => {
    expect(parseFeedDate(null, "+00:00")).toBeNull();
    expect(parseFeedDate("", "+00:00")).toBeNull();
    expect(parseFeedDate("yesterday", "+00:00")).toBeNull();
    expect(parseFeedDate("2026-02-31", "+00:00")).toBeNull();
    expect(parseFeedDate("2026-13-01", "+00:00")).toBeNull();
    expect(parseFeedDate("2026-10-22", "Asia/Shanghai")).toBeNull();
  });
});
