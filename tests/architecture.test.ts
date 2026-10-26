import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findCjk } from "./helpers/cjk-scan";
import { checkImportRules } from "./helpers/import-rules";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

const GUARDED = `import { createServerFn } from "@tanstack/react-start";
import { accessMiddleware } from "./fn";
export const f = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .handler(async () => 1);
`;

// The real middleware file, so "./fn" resolves in synthetic samples.
const FN = {
  "src/server/admin/fn.ts": "export const accessMiddleware = 1;",
};

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
        ...FN,
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

  it("does not report a route that reads from publication/ even if publication reads db/", () => {
    const v = checkImportRules(
      files({
        "src/routes/index.tsx": `import { getSiteInfo } from "../server/publication/site";`,
        "src/server/publication/site.ts": `import { getDb } from "../db/client";`,
        "src/server/db/client.ts": "",
      }),
    );
    expect(v).toEqual([]);
  });

  it("reports a route that reaches server/db through components/", () => {
    const v = checkImportRules(
      files({
        "src/routes/index.tsx": `import { Card } from "../components/Card";`,
        "src/components/Card.tsx": `import { getDb } from "../server/db/client";`,
        "src/server/db/client.ts": "",
      }),
    );
    expect(v).toContain(
      "R1 src/routes/index.tsx reaches src/server/db/client.ts via src/components/Card.tsx",
    );
    expect(v).toContain(
      "R1 src/components/Card.tsx reaches src/server/db/client.ts via src/components/Card.tsx",
    );
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
      "R1 src/routes/index.tsx reaches src/server/db/client.ts via src/routes/index.tsx",
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
        ...FN,
      }),
    );
    expect(v).toEqual([
      "R4 src/server/admin/x.ts has 1 server function(s) without accessMiddleware",
    ]);
  });

  it("does not report guarded server functions", () => {
    expect(
      checkImportRules(files({ "src/server/admin/x.ts": GUARDED, ...FN })),
    ).toEqual([]);
  });

  it("does not report an aliased, guarded server function", () => {
    const v = checkImportRules(
      files({
        "src/server/admin/x.ts": `import { createServerFn as c } from "@tanstack/react-start";
import { accessMiddleware as guard } from "./fn";
export const f = c({ method: "POST" }).middleware([guard]).handler(async () => 1);
`,
        ...FN,
      }),
    );
    expect(v).toEqual([]);
  });

  it("reports an aliased server function without the middleware", () => {
    const v = checkImportRules(
      files({
        "src/server/admin/x.ts": `import { createServerFn as c } from "@tanstack/react-start";
export const f = c({ method: "POST" }).handler(async () => 1);
`,
      }),
    );
    expect(v).toEqual([
      "R4 src/server/admin/x.ts has 1 server function(s) without accessMiddleware",
    ]);
  });

  it("reports a namespace-imported server function without the middleware", () => {
    const v = checkImportRules(
      files({
        "src/server/admin/x.ts": `import * as S from "@tanstack/react-start";
export const f = S.createServerFn({ method: "POST" }).handler(async () => 1);
`,
      }),
    );
    expect(v).toEqual([
      "R4 src/server/admin/x.ts has 1 server function(s) without accessMiddleware",
    ]);
  });

  it("reports a middleware named accessMiddleware that is not from fn.ts", () => {
    const v = checkImportRules(
      files({
        "src/server/admin/x.ts": `import { createServerFn } from "@tanstack/react-start";
const accessMiddleware = [];
export const f = createServerFn({ method: "POST" })
  .middleware([accessMiddleware])
  .handler(async () => 1);
`,
      }),
    );
    expect(v).toEqual([
      "R4 src/server/admin/x.ts has 1 server function(s) without accessMiddleware",
    ]);
  });

  it("reports createServerFn outside src/server/", () => {
    const v = checkImportRules(
      files({
        "src/routes/a.tsx": `import { createServerFn as c } from "@tanstack/react-start";
export const f = c({ method: "GET" }).handler(async () => 1);
`,
      }),
    );
    expect(v).toEqual([
      "R4 src/routes/a.tsx uses createServerFn outside src/server/",
    ]);
  });
});

describe("R0: relative code imports resolve", () => {
  it("resolves a .js specifier to the .ts file and reports the route", () => {
    const v = checkImportRules(
      files({
        "src/routes/index.tsx": `import { run } from "../pipeline/queue.js";`,
        "src/pipeline/queue.ts": "export const run = 1;",
      }),
    );
    expect(v).toEqual([
      "R1 src/routes/index.tsx reaches src/pipeline/queue.ts via src/routes/index.tsx",
      "R2 src/routes/index.tsx imports src/pipeline/queue.ts",
    ]);
  });

  it("reports a relative import that resolves to no file", () => {
    const v = checkImportRules(
      files({
        "src/routes/index.tsx": `import { x } from "../pipeline/gone";`,
      }),
    );
    expect(v).toEqual([
      "R0 src/routes/index.tsx cannot resolve ../pipeline/gone",
    ]);
  });

  it("does not report asset imports", () => {
    const v = checkImportRules(
      files({
        "src/routes/index.tsx": `import "./a.css";\nimport u from "./b.svg?url";`,
      }),
    );
    expect(v).toEqual([]);
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

describe("reader-visible text is English", () => {
  it("ignores CJK in comments and flags it in strings and JSX text", () => {
    const v = findCjk(
      files({
        "src/components/a.tsx": [
          "// 行注释",
          "/* 块注释",
          "   第二行 */",
          'const url = "http://example.com"; // 注释',
          "export const A = () => (",
          "  <p>{/* 注释 */}</p>",
          ");",
          'export const b = "中文";',
          "export const c = () => <p>全角：</p>;",
        ].join("\n"),
      }),
    );
    expect(v).toEqual(["src/components/a.tsx:8", "src/components/a.tsx:9"]);
  });

  it("finds no CJK in reader-visible source outside admin", () => {
    const root = join(import.meta.dirname, "..");
    const real = new Map<string, string>();
    for (const dir of [
      "src/components",
      "src/routes",
      "src/lib",
      "src/server/publication",
    ]) {
      for (const entry of readdirSync(join(root, dir), { recursive: true })) {
        const rel = `${dir}/${String(entry).split("\\").join("/")}`;
        if (!/\.tsx?$/.test(rel)) continue;
        if (rel.startsWith("src/routes/admin/")) continue;
        if (rel.startsWith("src/components/admin/")) continue;
        real.set(rel, readFileSync(join(root, rel), "utf8"));
      }
    }
    expect(real.has("src/components/artifacts/IndustryImpactCard.tsx")).toBe(
      true,
    );
    expect(real.has("src/routes/index.tsx")).toBe(true);
    expect(real.has("src/lib/site.ts")).toBe(true);
    expect(real.has("src/server/publication/feed.ts")).toBe(true);
    expect(findCjk(real)).toEqual([]);
  });
});
