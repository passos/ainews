import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThemeSwitcher } from "../src/components/ThemeSwitcher";

// #87: one icon toggle instead of a Light / Dark button group. No jsdom, so
// this checks the server markup, which is what the reader sees before mount.
const html = renderToStaticMarkup(createElement(ThemeSwitcher));
const text = html.replace(/<[^>]*>/g, " ");

describe("ThemeSwitcher markup", () => {
  it("renders exactly one button and no button group", () => {
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toContain('type="button"');
    expect(html).not.toContain('role="group"');
  });

  it("renders both icons and picks one with the dark variant", () => {
    expect(html.match(/<svg\b/g)).toHaveLength(2);
    // Moon shows in light, sun shows in dark: the server never knows which.
    expect(html).toMatch(/<svg[^>]*class="[^"]*\bdark:hidden\b/);
    expect(html).toMatch(/<svg[^>]*class="[^"]*\bhidden dark:block\b/);
    expect(html).toContain('stroke="currentColor"');
  });

  it("has a correct accessible name before mount", () => {
    expect(text).toContain("Switch to dark theme");
    expect(text).toContain("Switch to light theme");
    expect(html).toMatch(
      /<span class="sr-only[^"]*\bdark:hidden\b[^"]*">Switch to dark theme</,
    );
    expect(html).toMatch(
      /<span class="sr-only[^"]*\bhidden dark:inline\b[^"]*">Switch to light theme</,
    );
    expect(html).toMatch(/title="Switch to dark theme"/);
  });

  it("has no visible Theme label and no pressed state", () => {
    expect(text).not.toMatch(/\bTheme\b/);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("theme-label");
  });
});
