// Runs in the node project under TZ=UTC and TZ=Asia/Shanghai (npm run
// test:tz). The expected values are fixed UTC instants, so a result that
// depends on the machine's time zone fails in one of the two runs.
import { describe, expect, it } from "vitest";
import {
  dayBoundsUtc,
  formatUtc,
  localDate,
  parseFeedDate,
} from "../../src/lib/time";

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

  it("drops a trailing comment such as (EDT)", () => {
    expect(iso("Thu, 22 Oct 2026 00:00:00 -0400 (EDT)", "+08:00")).toBe(
      "2026-10-22T04:00:00.000Z",
    );
  });

  it("ignores an unknown zone name and uses the source offset", () => {
    for (const zone of ["BST", "CEST", "JST"]) {
      expect(iso(`Thu, 22 Oct 2026 10:00:00 ${zone}`, "+08:00")).toBe(
        "2026-10-22T02:00:00.000Z",
      );
    }
    expect(iso("2026-10-22 10:00 JST", "+09:00")).toBe(
      "2026-10-22T01:00:00.000Z",
    );
  });

  it("reads GMT+08:00 / UTC-0500 as that offset, not the source offset", () => {
    expect(iso("Thu, 22 Oct 2026 10:00:00 GMT+08:00", "-05:00")).toBe(
      "2026-10-22T02:00:00.000Z",
    );
    expect(iso("2026-10-22 10:00 UTC-0500", "+08:00")).toBe(
      "2026-10-22T15:00:00.000Z",
    );
  });

  it("reads 12-hour times with AM/PM", () => {
    expect(iso("Oct 22, 2026 10:00 PM")).toBe("2026-10-22T22:00:00.000Z");
    expect(iso("Oct 22, 2026 10:00 PM", "+08:00")).toBe(
      "2026-10-22T14:00:00.000Z",
    );
    expect(iso("Oct 22, 2026 12:30 AM")).toBe("2026-10-22T00:30:00.000Z");
    expect(iso("Oct 22, 2026 12:30 PM")).toBe("2026-10-22T12:30:00.000Z");
    expect(iso("Oct 22, 2026 1:05 am")).toBe("2026-10-22T01:05:00.000Z");
    expect(iso("Oct 22, 2026 10:00 p.m.")).toBe("2026-10-22T22:00:00.000Z");
    expect(iso("Oct 22, 2026 10:00 p. m.")).toBe("2026-10-22T22:00:00.000Z");
    expect(iso("Oct 22, 2026 10:00PM")).toBe("2026-10-22T22:00:00.000Z");
    expect(iso("2026-10-22 10:00 PM EST", "+08:00")).toBe(
      "2026-10-23T03:00:00.000Z",
    );
  });

  it("rejects an AM/PM hour outside 1-12", () => {
    expect(iso("Oct 22, 2026 13:00 PM")).toBeNull();
    expect(iso("Oct 22, 2026 0:30 AM")).toBeNull();
  });

  it("rejects letters after a date without a time", () => {
    expect(iso("2026-10-22 foo")).toBeNull();
    expect(iso("2026-10-22 PM")).toBeNull();
    expect(iso("Oct 22, 2026 JST")).toBeNull();
    // A known zone after a date alone still counts.
    expect(iso("2026-10-22 GMT", "+08:00")).toBe("2026-10-22T00:00:00.000Z");
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

describe("formatUtc", () => {
  // 2026-10-22T02:05:00Z is 10:05 in Asia/Shanghai: a local-time format
  // would show 10:05 AM in one of the two runs.
  const ms = Date.UTC(2026, 9, 22, 2, 5);

  it("formats in UTC with a UTC suffix, whatever the machine time zone", () => {
    expect(formatUtc(ms)).toBe("Oct 22, 2026, 2:05 AM UTC");
  });

  it("uses a plain space before AM/PM (ICU may emit U+202F)", () => {
    expect(formatUtc(Date.UTC(2026, 9, 22, 15, 30))).toBe(
      "Oct 22, 2026, 3:30 PM UTC",
    );
    expect(formatUtc(ms)).toMatch(/^[\x20-\x7e]+$/);
  });

  it("crosses the date line in UTC, not locally", () => {
    expect(formatUtc(Date.UTC(2026, 11, 31, 23, 59))).toBe(
      "Dec 31, 2026, 11:59 PM UTC",
    );
  });
});

describe("localDate", () => {
  it("formats date in requested time zone", () => {
    // 2026-10-21 16:30:00 UTC is 2026-10-22 00:30 in Asia/Shanghai
    const ms = Date.parse("2026-10-21T16:30:00.000Z");
    expect(localDate(ms, "UTC")).toBe("2026-10-21");
    expect(localDate(ms, "Asia/Shanghai")).toBe("2026-10-22");
    expect(localDate(ms, "America/New_York")).toBe("2026-10-21");
  });

  it("falls back to UTC on invalid time zone", () => {
    const ms = Date.parse("2026-10-21T16:30:00.000Z");
    expect(localDate(ms, "invalid/timezone")).toBe("2026-10-21");
  });
});

describe("dayBoundsUtc", () => {
  it("computes exact day bounds for Asia/Shanghai", () => {
    const [start, end] = dayBoundsUtc("2026-10-21", "Asia/Shanghai");
    expect(new Date(start).toISOString()).toBe("2026-10-20T16:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-10-21T16:00:00.000Z");
    expect(end - start).toBe(24 * 3600 * 1000);
  });

  it("handles DST transition in America/New_York (2026-03-08 is 23 hours)", () => {
    const [start, end] = dayBoundsUtc("2026-03-08", "America/New_York");
    expect(new Date(start).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect((end - start) / 3_600_000).toBe(23);
  });

  it("falls back to UTC on invalid time zone", () => {
    const [start, end] = dayBoundsUtc("2026-10-21", "Invalid/Timezone");
    expect(new Date(start).toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-10-22T00:00:00.000Z");
    expect(end - start).toBe(24 * 3600 * 1000);
  });
});
