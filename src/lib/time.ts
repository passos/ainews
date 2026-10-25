// Feed date parsing that does not depend on the machine's time zone.
// Strings are split into fields here and only handed to Date.parse with an
// explicit offset. Date.parse on a string without a zone, and
// new Date(y, m, d), use local time: do not use them.

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** RFC 822 zone names, with their US meaning. */
const ZONE_NAMES: Record<string, string> = {
  z: "+00:00",
  gmt: "+00:00",
  ut: "+00:00",
  utc: "+00:00",
  est: "-05:00",
  edt: "-04:00",
  cst: "-06:00",
  cdt: "-05:00",
  mst: "-07:00",
  mdt: "-06:00",
  pst: "-08:00",
  pdt: "-07:00",
};

// Any 2-5 letter name is taken. After a time, zoneOffset() ignores the ones
// it does not know (BST, CEST, JST are ambiguous or not RFC 822); after a
// date alone, an unknown name makes the string invalid.
const ZONE = String.raw`(Z|(?:GMT|UTC)?[+-]\d{2}:?\d{2}|[a-z]{2,5})`;
// The AM/PM group comes before ZONE and is greedy, so "PM" is never taken
// as a zone name. Accepts "PM", "pm", "p.m.", "p. m.".
const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:\s*([ap])\.?\s*m\.?)?`;

// 2026-10-22, 2026-10-22T10:00:00.5+08:00, 2026-10-22 10:00 GMT
const ISO = new RegExp(
  String.raw`^(\d{4})-(\d{2})-(\d{2})(?:[T ]${TIME})?\s*${ZONE}?$`,
  "i",
);
// Thu, 22 Oct 2026 00:00:00 -0400 (RFC 822 / 2822)
const DAY_MONTH = new RegExp(
  String.raw`^(?:[a-z]+,?\s+)?(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{2}|\d{4})(?:,?\s+${TIME})?\s*${ZONE}?$`,
  "i",
);
// Oct 14, 2026 / October 14, 2026 10:00
const MONTH_DAY = new RegExp(
  String.raw`^(?:[a-z]+,?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+${TIME})?\s*${ZONE}?$`,
  "i",
);

const OFFSET = /^[+-]\d{2}:\d{2}$/;

interface Fields {
  year: string;
  month: number;
  day: string;
  hour?: string;
  minute?: string;
  second?: string;
  fraction?: string;
  /** "a" or "p" for a 12-hour time. */
  meridiem?: string;
  zone?: string;
}

function split(raw: string): Fields | null {
  let m = ISO.exec(raw);
  if (m) {
    const [, year, month, day, hour, minute, second, fraction, meridiem, zone] =
      m;
    return {
      year,
      month: Number(month),
      day,
      hour,
      minute,
      second,
      fraction,
      meridiem,
      zone,
    };
  }
  m = DAY_MONTH.exec(raw);
  if (m) {
    const [, day, mon, year, hour, minute, second, fraction, meridiem, zone] =
      m;
    const y = year.length === 2 ? `20${year}` : year;
    return {
      year: y,
      month: MONTHS[mon.toLowerCase()] ?? 0,
      day,
      hour,
      minute,
      second,
      fraction,
      meridiem,
      zone,
    };
  }
  m = MONTH_DAY.exec(raw);
  if (m) {
    const [, mon, day, year, hour, minute, second, fraction, meridiem, zone] =
      m;
    return {
      year,
      month: MONTHS[mon.toLowerCase()] ?? 0,
      day,
      hour,
      minute,
      second,
      fraction,
      meridiem,
      zone,
    };
  }
  return null;
}

/** "+hh:mm" for a zone, or null for a name it does not know. */
function zoneOffset(zone: string): string | null {
  const named = ZONE_NAMES[zone.toLowerCase()];
  if (named) return named;
  // "-0400", "+08:00", "GMT+08:00", "UTC-0500"
  const m = /^(?:GMT|UTC)?([+-]\d{2}):?(\d{2})$/i.exec(zone);
  return m ? `${m[1]}:${m[2]}` : null;
}

const pad = (s: string | undefined) => (s ?? "0").padStart(2, "0");

/**
 * Hour as 0-23 text. 12-hour times: 12 AM = 0, 12 PM = 12, 1-11 PM + 12;
 * an hour outside 1-12 with AM/PM is invalid (null).
 */
function to24h(
  hour: string | undefined,
  meridiem: string | undefined,
): string | undefined | null {
  if (hour === undefined || meridiem === undefined) return hour;
  const h = Number(hour);
  if (h < 1 || h > 12) return null;
  const pm = meridiem.toLowerCase() === "p";
  return String((h % 12) + (pm ? 12 : 0));
}

/**
 * Parses a feed or page date. A date with an explicit zone uses that zone;
 * otherwise `utcOffset` ("+hh:mm" / "-hh:mm", the source's setting) is used.
 * A date without a time is midnight in that zone. Returns null if the
 * string or the offset is not understood.
 */
export function parseFeedDate(
  raw: string | null | undefined,
  utcOffset: string,
): Date | null {
  // A trailing comment such as "(EDT)" is dropped first (RFC 2822 allows it).
  const text = raw?.replace(/\s*\([^()]*\)\s*$/, "").trim();
  if (!text) return null;
  const f = split(text);
  if (!f || f.month < 1 || f.month > 12) return null;
  const hour = to24h(f.hour, f.meridiem);
  if (hour === null) return null;
  const known = f.zone ? zoneOffset(f.zone) : null;
  // An unknown zone name after a time is ignored (the source's offset is
  // used); after a date alone it is not a zone but garbage ("2026-10-22 foo").
  if (f.zone && !known && f.hour === undefined) return null;
  const offset = known ?? utcOffset;
  if (!OFFSET.test(offset)) return null;
  const iso =
    `${f.year}-${pad(String(f.month))}-${pad(f.day)}` +
    `T${pad(hour)}:${pad(f.minute)}:${pad(f.second)}${f.fraction ?? ""}` +
    offset;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  // Date.parse accepts some impossible dates (Feb 31): reject them.
  const check = new Date(ms + offsetMs(offset));
  if (check.getUTCDate() !== Number(f.day)) return null;
  return date;
}

function offsetMs(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return sign * (h * 60 + m) * 60_000;
}

// One shared format for server and client render, so hydration matches.
// Never uses the browser time zone.
const UTC_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * "Oct 22, 2026, 2:05 AM UTC" for epoch milliseconds. ICU 72+ puts U+202F
 * before AM/PM; engines differ, so it becomes a plain space.
 */
export function formatUtc(ms: number): string {
  return `${UTC_FORMAT.format(ms).replace(/\p{Zs}/gu, " ")} UTC`;
}

/**
 * Returns "YYYY-MM-DD" for epoch milliseconds in the given time zone.
 * Falls back to "UTC" if the time zone name is not recognized.
 */
export function localDate(ms: number, tz: string): string {
  let safeTz = tz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    safeTz = "UTC";
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(ms);
}

function getZonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  tz: string,
): number {
  let safeTz = tz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    safeTz = "UTC";
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  function getOffset(utcMs: number): number {
    const parts = formatter.formatToParts(utcMs);
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type !== "literal") map[p.type] = Number(p.value);
    }
    const h = map.hour === 24 ? 0 : (map.hour ?? 0);
    const localMs = Date.UTC(
      map.year ?? year,
      (map.month ?? month) - 1,
      map.day ?? day,
      h,
      map.minute ?? 0,
      map.second ?? 0,
    );
    return localMs - utcMs;
  }

  const targetLocalMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = targetLocalMs;
  guess = targetLocalMs - getOffset(guess);
  guess = targetLocalMs - getOffset(guess);
  return guess;
}

/**
 * Returns [startMs, endMs) UTC bounds for `dateStr` ("YYYY-MM-DD") in `tz`.
 * Handles DST shifts (e.g. 23-hour or 25-hour days) deterministically.
 */
export function dayBoundsUtc(dateStr: string, tz: string): [number, number] {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = getZonedMidnightUtc(y, m, d, tz);
  const nextDate = new Date(Date.UTC(y, m - 1, d + 1));
  const end = getZonedMidnightUtc(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    tz,
  );
  return [start, end];
}

/**
 * Returns [startMs, endMs) UTC bounds for a 7-day week starting on `mondayDateStr` ("YYYY-MM-DD") in `tz`.
 * Handles DST shifts deterministically across the 7-day span.
 */
export function weekBoundsUtc(
  mondayDateStr: string,
  tz: string,
): [number, number] {
  const [y, m, d] = mondayDateStr.split("-").map(Number);
  const start = getZonedMidnightUtc(y, m, d, tz);
  const nextMonday = new Date(Date.UTC(y, m - 1, d + 7));
  const end = getZonedMidnightUtc(
    nextMonday.getUTCFullYear(),
    nextMonday.getUTCMonth() + 1,
    nextMonday.getUTCDate(),
    tz,
  );
  return [start, end];
}

/**
 * Checks if a weekly digest is due for the given timestamp and timezone.
 * A weekly digest is due when the local date in `tz` is Monday (day 1).
 * When due, `periodStart` is the date string ("YYYY-MM-DD") of the preceding Monday (7 days prior).
 */
export function isWeeklyDigestDue(
  now: number,
  tz: string,
): { due: boolean; periodStart: string } {
  const todayStr = localDate(now, tz);
  const [y, m, d] = todayStr.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dayOfWeek === 1) {
    const prevMon = new Date(Date.UTC(y, m - 1, d - 7));
    const py = prevMon.getUTCFullYear();
    const pm = String(prevMon.getUTCMonth() + 1).padStart(2, "0");
    const pd = String(prevMon.getUTCDate()).padStart(2, "0");
    return { due: true, periodStart: `${py}-${pm}-${pd}` };
  }
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const lastMonday = new Date(Date.UTC(y, m - 1, d - daysSinceMonday - 7));
  const py = lastMonday.getUTCFullYear();
  const pm = String(lastMonday.getUTCMonth() + 1).padStart(2, "0");
  const pd = String(lastMonday.getUTCDate()).padStart(2, "0");
  return { due: false, periodStart: `${py}-${pm}-${pd}` };
}
