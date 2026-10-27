// E-ink restyle (#87 slice A): the public site uses neutral tokens only,
// self-hosted fonts and a favicon. These checks read the source files.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const css = read("src/styles.css");

// Public page sources: components and routes, without admin.
function publicSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of ["src/components", "src/routes"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true })) {
      const rel = `${dir}/${String(entry).split("\\").join("/")}`;
      if (!/\.tsx?$/.test(rel)) continue;
      if (rel.startsWith("src/routes/admin/")) continue;
      if (rel.startsWith("src/components/admin/")) continue;
      out.set(rel, read(rel));
    }
  }
  return out;
}

function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [rel, source] of publicSources()) {
    source.split("\n").forEach((line, i) => {
      if (pattern.test(line)) found.push(`${rel}:${i + 1}`);
    });
  }
  return found;
}

describe("palette", () => {
  it("has no section accent tokens", () => {
    expect(css).not.toMatch(/--sec\b|--sec-ink|--color-sec\b/);
  });

  it("public sources use no section accent utilities", () => {
    expect(publicSources().has("src/components/ArticleCard.tsx")).toBe(true);
    expect(hits(/\b(?:text|bg|border|decoration|ring)-sec(?:-ink)?\b/)).toEqual(
      [],
    );
  });

  it("public sources use no Tailwind palette colours", () => {
    expect(
      hits(
        /\b(?:bg|text|border|ring)-(?:red|blue|green|amber|yellow|emerald|sky|indigo|violet|purple|rose|orange|teal|cyan|lime|pink|fuchsia)-[0-9]/,
      ),
    ).toEqual([]);
  });

  it("the border is a hairline grey, not the ink colour", () => {
    const token = (name: string) =>
      [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))].map((m) =>
        m[1].trim(),
      );
    const borders = token("border");
    const inks = token("foreground");
    expect(borders.length).toBe(2);
    for (const b of borders) expect(inks).not.toContain(b);
  });
});

describe("fonts", () => {
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);

  it("declares Literata and Newsreader with font-display: swap", () => {
    const families = faces.map(
      (f) => /font-family:\s*"([^"]+)"/.exec(f)?.[1] ?? "",
    );
    expect(families).toContain("Literata");
    expect(families).toContain("Newsreader");
    for (const f of faces) expect(f).toMatch(/font-display:\s*swap/);
  });

  it("loads every font from public/fonts on the same origin", () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const f of faces) {
      const urls = [...f.matchAll(/url\(\s*"?([^")]+)"?\s*\)/g)].map(
        (m) => m[1],
      );
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(url).toMatch(/^\/fonts\/[a-z0-9-]+\.woff2$/);
        expect(existsSync(join(root, "public", url))).toBe(true);
      }
    }
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/);
  });
});

describe("favicon", () => {
  it("ships an svg icon and an ico file", () => {
    expect(read("public/favicon.svg")).toMatch(/^<svg\b/);
    const ico = readFileSync(join(root, "public/favicon.ico"));
    // ICONDIR: reserved 0, type 1 (icon), at least one image.
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(ico.readUInt16LE(4)).toBeGreaterThan(0);
  });
});
