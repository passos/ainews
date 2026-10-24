import { describe, expect, it } from "vitest";
import { PREFS_KEY } from "../src/lib/reader-prefs";
import { THEME_INIT_SCRIPT, applyTheme } from "../src/lib/theme";

// Run the inline head script against a fake localStorage and document.
function run(getItem: (key: string) => string | null): {
  theme: string | undefined;
  keys: string[];
} {
  const dataset: Record<string, string> = {};
  const document = { documentElement: { dataset } };
  const localStorage = { getItem };
  new Function("document", "localStorage", THEME_INIT_SCRIPT)(
    document,
    localStorage,
  );
  return { theme: dataset.theme, keys: Object.keys(dataset) };
}

const stored = (raw: string | null) => (key: string) =>
  key === PREFS_KEY ? raw : null;

describe("THEME_INIT_SCRIPT", () => {
  it("sets data-theme=dark when dark is stored", () => {
    expect(run(stored('{"theme":"dark","audience":"student"}')).theme).toBe(
      "dark",
    );
  });

  it("sets nothing for light, nothing stored, or another value", () => {
    for (const raw of [
      '{"theme":"light"}',
      "{}",
      null,
      '{"theme":"Dark"}',
      '{"theme":1}',
    ]) {
      expect(run(stored(raw)).keys).toEqual([]);
    }
  });

  it("sets nothing for bad JSON or a non-object, and does not throw", () => {
    for (const raw of ["{not json", "null", "[]", '"dark"', "42", "true"]) {
      expect(() => run(stored(raw))).not.toThrow();
      expect(run(stored(raw)).keys).toEqual([]);
    }
  });

  it("reads only the prefs key", () => {
    const seen: string[] = [];
    run((key) => {
      seen.push(key);
      return null;
    });
    expect(seen).toEqual([PREFS_KEY]);
  });

  it("does not throw when storage throws", () => {
    const boom = () => {
      throw new Error("blocked");
    };
    expect(() => run(boom)).not.toThrow();
    expect(run(boom).keys).toEqual([]);
  });
});

describe("applyTheme", () => {
  it("sets the attribute for dark and removes it for light", () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    };
    const original = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      documentElement: root,
    };
    try {
      applyTheme("dark");
      expect(attrs.get("data-theme")).toBe("dark");
      applyTheme("light");
      expect(attrs.has("data-theme")).toBe(false);
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });
});
