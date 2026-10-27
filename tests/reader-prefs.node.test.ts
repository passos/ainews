import { describe, expect, it } from "vitest";
import {
  parsePrefs,
  serializePrefs,
  toggleSection,
  toggleWatch,
  withTheme,
} from "../src/lib/reader-prefs";

describe("parsePrefs", () => {
  it("returns no preference for null, empty, or invalid JSON", () => {
    expect(parsePrefs(null)).toEqual({});
    expect(parsePrefs("")).toEqual({});
    expect(parsePrefs("{not json")).toEqual({});
  });

  it("returns no preference when the JSON is not an object", () => {
    for (const raw of ["null", "[]", '"student"', "42", "true"]) {
      expect(parsePrefs(raw)).toEqual({});
    }
  });

  it("treats a stored audience as an unknown field: kept as is, never checked", () => {
    for (const audience of ["student", "wizard"]) {
      expect(
        parsePrefs(JSON.stringify({ audience, sections: ["finance"] })),
      ).toEqual({ audience, sections: ["finance"] });
    }
  });

  it("keeps a known theme", () => {
    for (const t of ["light", "dark"]) {
      expect(parsePrefs(JSON.stringify({ theme: t }))).toEqual({ theme: t });
    }
  });

  it("drops an invalid theme and keeps the rest", () => {
    for (const bad of ['"blue"', "1", "null", '"Dark"']) {
      expect(parsePrefs(`{"theme":${bad},"audience":"student","x":1}`)).toEqual(
        { audience: "student", x: 1 },
      );
    }
  });

  it("drops sections that are not an array of strings", () => {
    expect(parsePrefs('{"sections":"finance"}')).toEqual({});
    expect(parsePrefs('{"sections":["finance",3]}')).toEqual({});
    expect(parsePrefs('{"sections":{"a":1}}')).toEqual({});
  });

  it("drops watches that are not an array of strings", () => {
    expect(parsePrefs('{"watches":"gpt-5"}')).toEqual({});
    expect(parsePrefs('{"watches":["gpt-5",3]}')).toEqual({});
    expect(parsePrefs('{"watches":{"a":1}}')).toEqual({});
  });

  it("keeps valid watches array of strings", () => {
    expect(parsePrefs('{"watches":["gpt-5","claude-4"]}')).toEqual({
      watches: ["gpt-5", "claude-4"],
    });
  });

  it("preserves unknown fields", () => {
    const prefs = parsePrefs('{"audience":"student","custom_flag":{"id":1}}');
    expect(prefs).toEqual({ audience: "student", custom_flag: { id: 1 } });
  });
});

describe("updates", () => {
  const raw =
    '{"audience":"student","custom":123,"sections":["finance"],"watches":["gpt-5"]}';

  it("withTheme keeps unknown fields", () => {
    const next = JSON.parse(serializePrefs(withTheme(parsePrefs(raw), "dark")));
    expect(next).toEqual({
      audience: "student",
      custom: 123,
      sections: ["finance"],
      watches: ["gpt-5"],
      theme: "dark",
    });
  });

  it("toggleSection adds and removes a slug, once", () => {
    const added = toggleSection(parsePrefs(raw), "education");
    expect(added.sections).toEqual(["finance", "education"]);
    const removed = toggleSection(added, "finance");
    expect(removed.sections).toEqual(["education"]);
    expect(removed.watches).toEqual(["gpt-5"]);
  });

  it("toggleSection starts from no preference", () => {
    expect(toggleSection({}, "technology")).toEqual({
      sections: ["technology"],
    });
  });

  it("toggleWatch adds and removes a watch slug, once", () => {
    const added = toggleWatch(parsePrefs(raw), "gemini-benchmark");
    expect(added.watches).toEqual(["gpt-5", "gemini-benchmark"]);
    const removed = toggleWatch(added, "gpt-5");
    expect(removed.watches).toEqual(["gemini-benchmark"]);
    expect(removed.sections).toEqual(["finance"]);
  });

  it("toggleWatch starts from no preference", () => {
    expect(toggleWatch({}, "gpt-5")).toEqual({
      watches: ["gpt-5"],
    });
  });
});
