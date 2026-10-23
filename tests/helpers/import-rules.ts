// Import rules from docs/architecture.md sections 2 and 3.
// Input: map of "src/..." path -> source. Output: one line per violation.
import { posix } from "node:path";

const IMPORT_PATTERNS = [
  /(?:import|export)\s[^'"]*?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*["']([^"']+)["']/g,
];

const ADMIN_FN_GUARDED =
  /createServerFn\([^)]*\)\s*\.middleware\(\[\s*accessMiddleware\b/g;

const ROUTE_TARGETS = [
  "src/server/publication/",
  "src/server/admin/",
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
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
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

export function checkImportRules(files: Map<string, string>): string[] {
  const violations: string[] = [];

  for (const [file, source] of files) {
    const isRoute = inDir(file, "src/routes/");
    const isPublication = inDir(file, "src/server/publication/");

    // R1: no path from public code to pipeline/ or providers/. Expansion
    // stops at server/admin/, which is behind Access.
    if (isRoute || isPublication) {
      const seen = new Set<string>([file]);
      const queue = [file];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const next of localImports(current, files)) {
          if (seen.has(next)) continue;
          seen.add(next);
          if (inDir(next, "src/pipeline/") || inDir(next, "src/providers/")) {
            violations.push(`R1 ${file} reaches ${next} via ${current}`);
            continue;
          }
          if (inDir(next, "src/server/admin/")) continue;
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

    // R4: every admin server function has accessMiddleware.
    if (inDir(file, "src/server/admin/")) {
      const total = source.match(/createServerFn\(/g)?.length ?? 0;
      const guarded = source.match(ADMIN_FN_GUARDED)?.length ?? 0;
      if (total !== guarded) {
        violations.push(
          `R4 ${file} has ${total - guarded} server function(s) without accessMiddleware`,
        );
      }
    }
  }

  return violations;
}
