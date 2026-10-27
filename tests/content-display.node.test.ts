import { expect, test } from "vitest";
import {
  DEFAULT_CONTENT_DISPLAY,
  parseContentDisplay,
} from "../src/lib/content-display";

test("new_sources_default_to_full", () => {
  expect(DEFAULT_CONTENT_DISPLAY).toBe("full");
});

test("unknown_stored_values_read_as_excerpt_not_full", () => {
  // Fail closed (N§6): a corrupt value must show less, not more.
  for (const value of [null, undefined, "", "FULL", "all", 1])
    expect(parseContentDisplay(value)).toBe("excerpt");
  for (const value of ["full", "excerpt", "summary"])
    expect(parseContentDisplay(value)).toBe(value);
});
