import { describe, expect, it } from "vitest";
import {
  parsePrefs,
  serializePrefs,
  toggleSection,
  withAudience,
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

  it("drops an unknown audience and keeps the rest", () => {
    expect(parsePrefs('{"audience":"wizard","sections":["finance"]}')).toEqual({
      sections: ["finance"],
    });
  });

  it("keeps a known audience", () => {
    for (const a of ["student", "educator", "professional"]) {
      expect(parsePrefs(JSON.stringify({ audience: a }))).toEqual({
        audience: a,
      });
    }
  });

  it("drops sections that are not an array of strings", () => {
    expect(parsePrefs('{"sections":"finance"}')).toEqual({});
    expect(parsePrefs('{"sections":["finance",3]}')).toEqual({});
    expect(parsePrefs('{"sections":{"a":1}}')).toEqual({});
  });

  it("preserves unknown fields (#17 adds watches)", () => {
    const prefs = parsePrefs('{"audience":"student","watches":[{"id":1}]}');
    expect(prefs).toEqual({ audience: "student", watches: [{ id: 1 }] });
  });
});

describe("updates", () => {
  const raw = '{"audience":"student","watches":[1],"sections":["finance"]}';

  it("withAudience keeps unknown fields", () => {
    const next = JSON.parse(
      serializePrefs(withAudience(parsePrefs(raw), "educator")),
    );
    expect(next).toEqual({
      audience: "educator",
      watches: [1],
      sections: ["finance"],
    });
  });

  it("toggleSection adds and removes a slug, once", () => {
    const added = toggleSection(parsePrefs(raw), "education");
    expect(added.sections).toEqual(["finance", "education"]);
    const removed = toggleSection(added, "finance");
    expect(removed.sections).toEqual(["education"]);
    expect(removed.watches).toEqual([1]);
  });

  it("toggleSection starts from no preference", () => {
    expect(toggleSection({}, "technology")).toEqual({
      sections: ["technology"],
    });
  });
});
