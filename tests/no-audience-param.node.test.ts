// #87 slice A2: the audience URL parameter is gone. No public link adds it,
// nothing syncs it from localStorage, and the root route does not validate it.
// A URL that still carries ?audience=... is ignored (the page renders as for
// any other unknown parameter). These checks read the source files; the
// rendered-link and 200 checks are in tests/routes/event-audience.test.ts and
// scripts/smoke-ssr.ts.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

// Reader-facing sources. The artifact cards keep their own in-page audience
// tier switch (component state, not the URL); admin has its own pages.
function readerSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of ["src/components", "src/routes", "src/lib"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true })) {
      const rel = `${dir}/${String(entry).split("\\").join("/")}`;
      if (!/\.tsx?$/.test(rel)) continue;
      if (rel.startsWith("src/routes/admin/")) continue;
      if (rel.startsWith("src/components/admin/")) continue;
      if (rel.startsWith("src/components/artifacts/")) continue;
      if (rel.startsWith("src/lib/artifacts/")) continue;
      out.set(rel, read(rel));
    }
  }
  return out;
}

function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const [rel, source] of readerSources()) {
    source.split("\n").forEach((line, i) => {
      // The in-page tier card and its tier list are not the URL parameter.
      const text = line.replace(/AudienceExplainCard|ARTIFACT_AUDIENCES/g, "");
      if (pattern.test(text)) found.push(`${rel}:${i + 1}`);
    });
  }
  return found;
}

describe("no audience URL parameter", () => {
  it("reader sources never mention the audience parameter or its helpers", () => {
    expect(readerSources().has("src/routes/__root.tsx")).toBe(true);
    expect(hits(/audience/i)).toEqual([]);
  });

  it("PrefsSync is gone", () => {
    expect(existsSync(join(root, "src/components/PrefsSync.tsx"))).toBe(false);
    expect(hits(/PrefsSync/)).toEqual([]);
  });

  it("the root route has no search validation, so ?audience= is not read", () => {
    const rootSource = read("src/routes/__root.tsx");
    expect(rootSource).not.toContain("validateSearch");
    expect(rootSource).not.toContain("Route.useSearch");
  });

  it("the explain and learn cards still start at Student (no URL input)", () => {
    const page = read("src/routes/e/$eventId.tsx");
    expect(page).not.toContain("initialAudience");
  });
});
