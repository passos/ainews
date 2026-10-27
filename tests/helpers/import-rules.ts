// Import rules from docs/architecture/architecture.md sections 2 and 3.
// Input: map of "src/..." path -> source. Output: one line per violation.
import { posix } from "node:path";

const IMPORT_PATTERNS = [
  /(?:import|export)\s[^'"]*?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*["']([^"']+)["']/g,
];

const ACCESS_FN_FILE = "src/server/admin/fn.ts";

// Relative imports that are not code: CSS, images, `?url` and similar.
const ASSET =
  /\?|\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|json|txt|md|html)$/i;

const ROUTE_TARGETS = [
  "src/server/publication/",
  "src/server/admin/",
  "src/server/reader-watch/",
  "src/server/reader-ask/",
  "src/components/",
  "src/lib/",
  "src/routes/",
];

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

// Resolves a relative specifier to a .ts/.tsx key in `files`, or null.
function resolve(
  from: string,
  spec: string,
  files: Map<string, string>,
): string | null {
  // "./x.js" may point at x.ts (TypeScript ESM style).
  const stripped = spec.replace(/\.(m?js|jsx)$/, "");
  const base = posix.normalize(posix.join(posix.dirname(from), stripped));
  const candidates = /\.tsx?$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((c) => files.has(c)) ?? null;
}

function localImports(file: string, files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const spec of specifiers(files.get(file) ?? "")) {
    if (!spec.startsWith(".")) continue;
    const target = resolve(file, spec, files);
    if (target) out.push(target);
  }
  return out;
}

const inDir = (file: string, dir: string) => file.startsWith(dir);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Local names bound to export `name` by imports whose specifier passes
// `accept`: `{ name }`, `{ name as x }` and `* as ns` (as "ns.name").
function localNames(
  source: string,
  name: string,
  accept: (spec: string) => boolean,
): string[] {
  const names: string[] = [];
  const imports =
    /\bimport\s+(?:type\s+)?([^'";]*?)\s+from\s*["']([^"']+)["']/g;
  for (const [, clause, spec] of source.matchAll(imports)) {
    if (!accept(spec)) continue;
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) names.push(`${ns[1]}.${name}`);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) continue;
    for (const part of braces[1].split(",")) {
      const [imported, local] = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      if (imported === name) names.push(local ?? imported);
    }
  }
  return names;
}

// Names that call createServerFn in `source`. The plain name always counts;
// aliases count from any import source.
function serverFnNames(source: string): Set<string> {
  return new Set([
    "createServerFn",
    ...localNames(source, "createServerFn", () => true),
  ]);
}

// Start of a call by local name `fn`, not as a property of something else.
const callOf = (fn: string) => `(?<![\\w$.])${escapeRe(fn)}\\s*\\(`;

// A dynamic import() that specifiers() does not see.
const NON_LITERAL_IMPORT = /(?<![\w$.])import\s*\((?!\s*["'][^"']+["']\s*\))/;

// R4 for one admin file: counts server function calls that do not chain
// `.middleware([accessMiddleware` directly, by the names the file imports.
function unguardedServerFns(
  file: string,
  source: string,
  files: Map<string, string>,
): number {
  const fnNames = serverFnNames(source);
  const mwNames = localNames(
    source,
    "accessMiddleware",
    (spec) =>
      spec.startsWith(".") && resolve(file, spec, files) === ACCESS_FN_FILE,
  );
  if (file === ACCESS_FN_FILE) mwNames.push("accessMiddleware");
  let unguarded = 0;
  for (const fn of fnNames) {
    const call = callOf(fn);
    const total = source.match(new RegExp(call, "g"))?.length ?? 0;
    let guarded = 0;
    if (mwNames.length > 0) {
      const mw = mwNames.map(escapeRe).join("|");
      const pattern = `${call}[^)]*\\)\\s*\\.middleware\\(\\[\\s*(?:${mw})\\b`;
      guarded = source.match(new RegExp(pattern, "g"))?.length ?? 0;
    }
    unguarded += total - guarded;
  }
  return unguarded;
}

export function checkImportRules(files: Map<string, string>): string[] {
  const violations: string[] = [];

  for (const [file, source] of files) {
    const isRoute = inDir(file, "src/routes/");
    const isPublication = inDir(file, "src/server/publication/");
    const isPublicEntry =
      (isRoute && !inDir(file, "src/routes/admin/")) ||
      inDir(file, "src/components/");
    const isAdminRoute = inDir(file, "src/routes/admin/");
    const isReaderWatch = inDir(file, "src/server/reader-watch/");
    const isReaderAsk = inDir(file, "src/server/reader-ask/");
    // Public write entries (architecture §3): same import limits for both.
    const isPublicWrite = isReaderWatch || isReaderAsk;

    // R0: every relative code import resolves to a file, so R1/R2 cannot
    // miss one through a spelling the resolver does not understand.
    for (const spec of specifiers(source)) {
      if (!spec.startsWith(".") || ASSET.test(spec)) continue;
      if (!resolve(file, spec, files)) {
        violations.push(`R0 ${file} cannot resolve ${spec}`);
      }
    }
    if (NON_LITERAL_IMPORT.test(source)) {
      violations.push(
        `R0 ${file} has a dynamic import without a string literal`,
      );
    }

    // R1: public code cannot reach server/db/, pipeline/ or providers/.
    // Publication and admin routes cannot reach pipeline/ or providers/.
    // server/reader-watch/ and server/reader-ask/ cannot reach server/admin/
    // either. Traversal stops at server/admin/ (Access-guarded),
    // server/publication/, server/reader-watch/ and server/reader-ask/.
    if (isPublicEntry || isPublication || isAdminRoute || isPublicWrite) {
      const seen = new Set<string>([file]);
      const queue = [file];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const next of localImports(current, files)) {
          if (seen.has(next)) continue;
          seen.add(next);
          const forbidden =
            inDir(next, "src/pipeline/") ||
            inDir(next, "src/providers/") ||
            (isPublicEntry && inDir(next, "src/server/db/")) ||
            (isPublicWrite && inDir(next, "src/server/admin/"));
          if (forbidden) {
            violations.push(`R1 ${file} reaches ${next} via ${current}`);
            continue;
          }
          if (inDir(next, "src/server/admin/")) continue;
          if (isPublicEntry && inDir(next, "src/server/publication/")) continue;
          if (isPublicEntry && inDir(next, "src/server/reader-watch/"))
            continue;
          if (isPublicEntry && inDir(next, "src/server/reader-ask/")) continue;
          queue.push(next);
        }
      }
    }

    // R2: routes import src/ code only from the allowed directories.
    if (isRoute) {
      for (const target of localImports(file, files)) {
        if (!ROUTE_TARGETS.some((dir) => inDir(target, dir))) {
          violations.push(`R2 ${file} imports ${target}`);
        }
      }
    }

    // R3: no env access in routes or components.
    if (isRoute || inDir(file, "src/components/")) {
      if (specifiers(source).includes("cloudflare:workers")) {
        violations.push(`R3 ${file} imports cloudflare:workers`);
      }
    }

    // R4: server functions live only in src/server/, and every admin server
    // function has accessMiddleware.
    if (!inDir(file, "src/server/") && /\bcreateServerFn\b/.test(source)) {
      violations.push(`R4 ${file} uses createServerFn outside src/server/`);
    }
    if (inDir(file, "src/server/admin/")) {
      const unguarded = unguardedServerFns(file, source, files);
      if (unguarded !== 0) {
        violations.push(
          `R4 ${file} has ${unguarded} server function(s) without accessMiddleware`,
        );
      }
    }

    // R5: every server function in server/reader-watch/ and
    // server/reader-ask/ is POST.
    if (isPublicWrite) {
      let notPost = 0;
      for (const fn of serverFnNames(source)) {
        const call = callOf(fn);
        const post = `${call}\\s*\\{\\s*method:\\s*"POST"\\s*\\}\\s*\\)`;
        notPost +=
          (source.match(new RegExp(call, "g"))?.length ?? 0) -
          (source.match(new RegExp(post, "g"))?.length ?? 0);
      }
      if (notPost !== 0) {
        violations.push(`R5 ${file} has a server function that is not POST`);
      }
    }
  }

  return violations;
}
