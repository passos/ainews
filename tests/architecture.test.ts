import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkImportRules } from "./helpers/import-rules";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const GUARDED = `import { createServerFn } from "@tanstack/react-start";
import { accessMiddleware } from "./fn";
export const f = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .handler(async () => 1);
`;

describe("R1: public code does not reach pipeline/ or providers/", () => {
  it("reports a route that imports pipeline/", () => {
    const v = checkImportRules(
      files({
        "src/routes/index.tsx": `import { run } from "../pipeline/queue";`,
        "src/pipeline/queue.ts": "export const run = 1;",
      }),
    );
    expect(v).toEqual([
      "R1 src/routes/index.tsx reaches src/pipeline/queue.ts via src/routes/index.tsx",
      // A direct import of pipeline/ also breaks R2.
      "R2 src/routes/index.tsx imports src/pipeline/queue.ts",
    ]);
  });

  it("reports publication/ that reaches providers/ through lib/", () => {
    const v = checkImportRules(
      files({
        "src/server/publication/site.ts": `export * from "../../lib/x";`,
        "src/lib/x.ts": `import "../providers/models";`,
        "src/providers/models.ts": "",
      }),
    );
    expect(v).toEqual([
      "R1 src/server/publication/site.ts reaches src/providers/models.ts via src/lib/x.ts",
    ]);
  });

  it("reports a dynamic import of providers/", () => {
    const v = checkImportRules(
      files({
        "src/routes/a.tsx": `const m = () => import("../providers/models");`,
        "src/providers/models.ts": "",
      }),
    );
    expect(v.filter((x) => x.startsWith("R1"))).toHaveLength(1);
  });

  it("does not report providers/ reached only through server/admin/", () => {
    const v = checkImportRules(
      files({
        "src/routes/admin/index.tsx": `import { f } from "../../server/admin/x";`,
        "src/server/admin/x.ts": `${GUARDED}import { m } from "../../providers/models";`,
        "src/providers/models.ts": "",
      }),
    );
    expect(v).toEqual([]);
  });

  it("does not report a route that reads from publication/", () => {
    const v = checkImportRules(
      files({
        "src/routes/index.tsx": `import { getSiteInfo } from "../server/publication/site";`,
        "src/server/publication/site.ts": `import { z } from "zod";`,
      }),
    );
    expect(v).toEqual([]);
  });
});

describe("R2: routes read only through publication/ or admin/", () => {
  it("reports a route that imports server/db/", () => {
    const v = checkImportRules(
      files({
        "src/routes/index.tsx": `import { getDb } from "../server/db/client";`,
        "src/server/db/client.ts": "",
      }),
    );
    expect(v).toEqual([
      "R2 src/routes/index.tsx imports src/server/db/client.ts",
    ]);
  });

  it("does not report imports of allowed directories or packages", () => {
    const v = checkImportRules(
      files({
        "src/routes/a.tsx": [
          `import { x } from "../components/x";`,
          `import { y } from "../lib/y";`,
          `import { z } from "./b";`,
          `import "./style.css";`,
          `import { useState } from "react";`,
        ].join("\n"),
        "src/components/x.tsx": "",
        "src/lib/y.ts": "",
        "src/routes/b.tsx": "",
      }),
    );
    expect(v).toEqual([]);
  });
});

describe("R3: no cloudflare:workers in routes or components", () => {
  it("reports a component that imports cloudflare:workers", () => {
    const v = checkImportRules(
      files({
        "src/components/x.tsx": `import { env } from "cloudflare:workers";`,
      }),
    );
    expect(v).toEqual(["R3 src/components/x.tsx imports cloudflare:workers"]);
  });

  it("does not report cloudflare:workers in server/admin/", () => {
    const v = checkImportRules(
      files({
        "src/server/admin/fn.ts": `import { env } from "cloudflare:workers";`,
      }),
    );
    expect(v).toEqual([]);
  });
});

describe("R4: every admin server function uses accessMiddleware", () => {
  it("reports a server function without the middleware", () => {
    const v = checkImportRules(
      files({
        "src/server/admin/x.ts": `${GUARDED}
export const g = createServerFn({ method: "GET" }).handler(async () => 2);
`,
      }),
    );
    expect(v).toEqual([
      "R4 src/server/admin/x.ts has 1 server function(s) without accessMiddleware",
    ]);
  });

  it("does not report guarded server functions", () => {
    expect(
      checkImportRules(files({ "src/server/admin/x.ts": GUARDED })),
    ).toEqual([]);
  });
});

describe("the real repository", () => {
  it("has no violations", () => {
    const root = join(import.meta.dirname, "..");
    const real = new Map<string, string>();
    const entries = readdirSync(join(root, "src"), { recursive: true });
    for (const entry of entries) {
      const rel = String(entry).split("\\").join("/");
      if (!/\.tsx?$/.test(rel)) continue;
      real.set(`src/${rel}`, readFileSync(join(root, "src", rel), "utf8"));
    }
    // Guard against an empty walk passing by accident.
    expect(real.has("src/routes/index.tsx")).toBe(true);
    expect(real.has("src/server/admin/identity.ts")).toBe(true);
    expect(checkImportRules(real)).toEqual([]);
  });
});
