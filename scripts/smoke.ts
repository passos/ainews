// Anonymous observation only. Importing this module performs no I/O.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parse } from "node-html-parser";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

const sections = ["technology", "education", "industry", "finance"] as const;
export type SmokeMode = "routes" | "launch";
export interface SmokeManifest {
  eventIds: number[];
  watchSlugs: string[];
  digests: { section: string; date: string; kind: "daily" | "weekly" }[];
  funding: boolean;
}
export interface SmokeOptions {
  baseUrl: string;
  mode: SmokeMode;
  online: boolean;
  manifest?: SmokeManifest;
  accessOrigin?: string;
}
export interface SmokeResult {
  ok: boolean;
  executed: boolean;
  contentReadiness: "unchecked" | "checked";
  cases: {
    name: string;
    path: string;
    ok: boolean;
    code: string;
    status?: number;
    bytes?: number;
    elapsedMs?: number;
  }[];
}
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(200);
function calendar(s: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    s >= "0001-01-01" &&
    Number.isFinite(Date.parse(`${s}T00:00:00Z`)) &&
    new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s
  );
}
const manifestSchema = z.strictObject({
  eventIds: z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .default([]),
  watchSlugs: z.array(slug).default([]),
  digests: z
    .array(
      z.strictObject({
        section: z.enum(sections),
        date: z.string().refine(calendar),
        kind: z.enum(["daily", "weekly"]),
      }),
    )
    .default([]),
  funding: z.boolean().default(false),
});
const optionsSchema = z.strictObject({
  baseUrl: z.string(),
  mode: z.enum(["routes", "launch"]),
  online: z.boolean(),
  manifest: manifestSchema.optional(),
  accessOrigin: z.string().optional(),
});
class SmokeError extends Error {
  constructor(code: string) {
    super(code);
  }
}
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new SmokeError(code);
}
function origin(value: string, access = false): string {
  requireThat(/^https?:\/\/[^/?#\\\s]+\/?$/.test(value), "INVALID_ARGUMENTS");
  const u = new URL(value);
  requireThat(!u.username && !u.password, "INVALID_ARGUMENTS");
  const authority = value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  requireThat(
    u.protocol === "https:" ||
      /^(127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(authority),
    "INVALID_ARGUMENTS",
  );
  requireThat(
    u.protocol === "https:" ||
      (!access &&
        u.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(u.hostname)),
    "INVALID_ARGUMENTS",
  );
  return u.origin;
}
function normalized(options: SmokeOptions): SmokeOptions {
  const o = optionsSchema.parse(options);
  return {
    ...o,
    baseUrl: origin(o.baseUrl),
    accessOrigin:
      o.accessOrigin === undefined ? undefined : origin(o.accessOrigin, true),
  };
}
export function buildSmokePlan(options: SmokeOptions): readonly string[] {
  const o = normalized(options),
    m = o.manifest;
  const paths = [
    "/",
    ...sections.map((s) => `/s/${s}`),
    ...sections.map((s) => `/rss/${s}.xml`),
    ...sections.map((s) => `/rss/digest/${s}.xml`),
    "/s/__smoke_missing__",
    "/rss/__smoke_missing__.xml",
    "/admin",
  ];
  if (m)
    paths.push(
      ...m.eventIds.map((id) => `/e/${id}`),
      ...m.watchSlugs.flatMap((s) => [`/w/${s}`, `/rss/w/${s}.xml`]),
      ...m.digests.map(
        (d) =>
          `/digest/${d.section}/${d.date}${d.kind === "weekly" ? "?kind=weekly" : ""}`,
      ),
      ...(m.funding ? ["/funding"] : []),
    );
  const unique = [...new Set(paths)];
  requireThat(unique.length <= 64, "INVALID_ARGUMENTS");
  return unique;
}
function complete(m?: SmokeManifest): boolean {
  return (
    !!m &&
    m.eventIds.length > 0 &&
    m.watchSlugs.length > 0 &&
    m.funding &&
    m.digests.some((d) => d.section === "technology" && d.kind === "daily") &&
    m.digests.some((d) => d.kind === "weekly")
  );
}
function visible(html: string) {
  const dom = parse(html);
  dom
    .querySelectorAll(
      'script,style,template,noscript,[hidden],[aria-hidden="true"]',
    )
    .forEach((n) => n.remove());
  dom
    .querySelectorAll("[style]")
    .filter((n) =>
      /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
        n.getAttribute("style") ?? "",
      ),
    )
    .forEach((n) => n.remove());
  return dom;
}
function text(html: string): string {
  return visible(html).structuredText.replace(/\s+/g, " ").trim();
}
function notice(html: string): boolean {
  return /\bNot investment advice\b/i.test(text(html));
}
function htmlCheck(body: string, path: string, baseUrl: string) {
  requireThat(/^\s*<!doctype html\s*>/i.test(body), "HTML_FORMAT");
  const dom = visible(body),
    main = dom.querySelector("main"),
    h1 = main?.querySelector("h1")?.text.trim();
  requireThat(
    main &&
      h1 &&
      /Personal\s+News/i.test(
        dom.querySelector("body")?.structuredText ?? "",
      ) &&
      /Personal\s+News/i.test(dom.querySelector("title")?.text ?? ""),
    "HTML_SSR",
  );
  const section = path.split("/")[2];
  if (path === "/") {
    for (const s of sections)
      requireThat(
        main
          .querySelectorAll("a[href]")
          .some(
            (a) =>
              a.text.trim() &&
              localLink(a.getAttribute("href")!, baseUrl) === `/s/${s}`,
          ),
        "HTML_NAVIGATION",
      );
  } else if (path.startsWith("/s/") || path.startsWith("/digest/")) {
    requireThat(
      main.querySelector(`[data-section="${section}"]`) &&
        h1.toLowerCase().includes(section),
      "HTML_SECTION",
    );
    if (path.startsWith("/digest/"))
      requireThat(
        h1.includes(path.split("/")[3].split("?")[0]) &&
          h1.includes(
            path.includes("?kind=weekly") ? "Weekly Digest" : "Daily Digest",
          ) &&
          /Top Developments/i.test(main.structuredText),
        "HTML_DIGEST",
      );
  } else if (path.startsWith("/e/")) {
    requireThat(
      main
        .querySelectorAll("[data-section]")
        .some((n) =>
          sections.includes(
            n.getAttribute("data-section") as (typeof sections)[number],
          ),
        ) &&
        main.querySelectorAll("h2").some((n) => n.text.trim() === "Timeline"),
      "HTML_EVENT",
    );
  } else if (path.startsWith("/w/")) {
    requireThat(
      /Criterion for Update:/i.test(main.structuredText) &&
        /Material Developments/i.test(main.structuredText) &&
        main
          .querySelectorAll("a[href]")
          .some(
            (a) =>
              localLink(a.getAttribute("href")!, baseUrl) ===
              `/rss/w/${path.split("/")[2]}.xml`,
          ),
      "HTML_WATCH",
    );
  } else if (path === "/funding") {
    // #23 renders ul/li cards under section[aria-label="Rounds"], or one empty
    // paragraph there; it renders no table.
    const rounds = main.querySelector('section[aria-label="Rounds"]'),
      cards = rounds?.querySelectorAll("ul > li") ?? [];
    requireThat(
      /Funding.*Tracker/i.test(h1) &&
        main.querySelector('section[aria-label="Trends"]') &&
        rounds &&
        (cards.length > 0
          ? cards.every((c) => c.querySelector("h3")?.text.trim())
          : /No funding rounds match/i.test(rounds.text)),
      "HTML_FUNDING",
    );
  }
  if (
    section === "finance" ||
    path === "/funding" ||
    main.querySelector('[data-section="finance"]')
  )
    requireThat(notice(main.innerHTML), "FINANCE_NOTICE");
}
function localLink(value: string, baseUrl: string): string | null {
  try {
    const u = new URL(value, baseUrl);
    return u.origin === baseUrl && !u.username && !u.password && !u.hash
      ? u.pathname + u.search
      : null;
  } catch {
    return null;
  }
}
const field = z.string().trim().min(1);
const xmlText = z
  .union([field, z.object({ "#text": field })])
  .transform((v) => (typeof v === "string" ? v : v["#text"]));
const itemSchema = z.object({
  title: field,
  guid: xmlText,
  description: field,
  link: field.optional(),
  pubDate: field.optional(),
});
const rssSchema = z.object({
  rss: z.object({
    "@_version": z.literal("2.0"),
    channel: z.object({
      title: field,
      link: field,
      description: field,
      item: z.array(itemSchema).optional(),
    }),
  }),
});
function rssCheck(body: string, path: string, o: SmokeOptions) {
  requireThat(
    !/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(body) &&
      XMLValidator.validate(body) === true,
    "RSS_XML",
  );
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    isArray: (_name, p) => p === "rss.channel.item",
  }).parse(body);
  requireThat(
    Object.keys(parsed).every((k) => ["?xml", "rss"].includes(k)),
    "RSS_FORMAT",
  );
  const result = rssSchema.safeParse(parsed);
  requireThat(result.success, "RSS_FORMAT");
  const c = result.data.rss.channel,
    items = c.item ?? [],
    watch = path.startsWith("/rss/w/"),
    digest = path.startsWith("/rss/digest/");
  const s = path
    .split("/")
    .at(-1)!
    .replace(/\.xml$/, "");
  requireThat(
    c.title.includes("Personal News") &&
      (watch
        ? c.title.includes("Watch:")
        : c.title.toLowerCase().includes(s)) &&
      (!digest || c.title.includes("Digests")),
    "RSS_TITLE",
  );
  requireThat(
    localLink(c.link, o.baseUrl) === (watch ? `/w/${s}` : `/s/${s}`),
    "RSS_LINK",
  );
  const guids = new Set<string>();
  for (const item of items) {
    requireThat(!guids.has(item.guid), "RSS_GUID");
    guids.add(item.guid);
    requireThat(
      !item.pubDate || Number.isFinite(Date.parse(item.pubDate)),
      "RSS_DATE",
    );
    if (digest || watch) {
      const link = item.link && localLink(item.link, o.baseUrl);
      const match =
        link &&
        (watch
          ? /^\/e\/([1-9]\d*)$/.exec(link)
          : new RegExp(
              `^/digest/${s}/(\\d{4}-\\d{2}-\\d{2})(?:\\?kind=weekly)?$`,
            ).exec(link));
      requireThat(
        match &&
          (watch ? Number.isSafeInteger(Number(match[1])) : calendar(match[1])),
        "RSS_LINK",
      );
    } else if (item.link) {
      const u = new URL(item.link);
      requireThat(
        ["http:", "https:"].includes(u.protocol) && !u.username && !u.password,
        "RSS_LINK",
      );
    }
  }
  if (s === "finance" || /\bFinance\b/i.test(c.title) || notice(c.description))
    requireThat(
      notice(c.description) && items.every((i) => notice(i.description)),
      "FINANCE_NOTICE",
    );
  if (o.mode === "launch" && !digest && !watch)
    requireThat(items.length > 0, "EMPTY_SECTION");
}
function validateResponse(
  body: string,
  path: string,
  response: Response,
  o: SmokeOptions,
) {
  if (path === "/admin") {
    if ([401, 403].includes(response.status)) return;
    requireThat(
      [302, 303, 307].includes(response.status) && o.accessOrigin,
      "ADMIN_ACCESS",
    );
    const location = response.headers.get("location");
    requireThat(
      location && /^https:\/\//.test(location) && !/[\\\s]/.test(location),
      "ADMIN_ACCESS",
    );
    const u = new URL(location);
    requireThat(
      u.origin === o.accessOrigin &&
        !u.username &&
        !u.password &&
        u.protocol === "https:",
      "ADMIN_ACCESS",
    );
    return;
  }
  if (path.includes("__smoke_missing__")) {
    requireThat(response.status === 404, "EXPECTED_404");
    return;
  }
  requireThat(response.status === 200, "HTTP_STATUS");
  const xml = path.startsWith("/rss/"),
    media = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
  requireThat(
    media === (xml ? "application/rss+xml" : "text/html"),
    "CONTENT_TYPE",
  );
  if (xml) rssCheck(body, path, o);
  else htmlCheck(body, path, o.baseUrl);
}
export async function runSmoke(
  options: SmokeOptions,
  deps: { fetch?: typeof fetch } = {},
): Promise<SmokeResult> {
  const o = normalized(options),
    paths = buildSmokePlan(o);
  const cases: SmokeResult["cases"] = paths.map((path, i) => ({
    name: `case-${i + 1}`,
    path,
    ok: false,
    code: "NOT_EXECUTED",
  }));
  if (o.mode === "launch" && !complete(o.manifest))
    return {
      ok: false,
      executed: false,
      contentReadiness: "unchecked",
      cases: cases.map((c) => ({ ...c, code: "INCOMPLETE_MANIFEST" })),
    };
  if (!o.online)
    return { ok: true, executed: false, contentReadiness: "unchecked", cases };
  const fetcher = deps.fetch ?? globalThis.fetch,
    deadline = Date.now() + 120_000;
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const c = cases[next++],
        start = Date.now(),
        remaining = deadline - start;
      if (remaining <= 0) {
        c.code = "TOTAL_TIMEOUT";
        continue;
      }
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
        timer: ReturnType<typeof setTimeout> | undefined;
      let bytes = 0;
      try {
        const request = async () => {
          const response = await fetcher(o.baseUrl + c.path, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new SmokeError("REQUEST_TIMEOUT");
          }
          c.status = response.status;
          const chunks: Uint8Array[] = [];
          reader = response.body?.getReader();
          if (reader) {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              requireThat(bytes <= 2 * 1024 * 1024, "BODY_LIMIT");
              chunks.push(part.value);
            }
          }
          const body = Buffer.concat(chunks).toString("utf8");
          validateResponse(body, c.path, response, o);
        };
        await Promise.race([
          request(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new SmokeError(
                    remaining <= 10_000 ? "TOTAL_TIMEOUT" : "REQUEST_TIMEOUT",
                  ),
                ),
              Math.min(10_000, remaining),
            );
          }),
        ]);
        c.ok = true;
        c.code = "PASS";
      } catch (error) {
        c.code = error instanceof SmokeError ? error.message : "REQUEST_FAILED";
      } finally {
        clearTimeout(timer);
        controller.abort();
        if (reader) {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        c.bytes = bytes;
        c.elapsedMs = Date.now() - start;
      }
    }
  }
  await Promise.all([worker(), worker()]);
  const ok = cases.every((c) => c.ok);
  return {
    ok,
    executed: true,
    contentReadiness: ok && o.mode === "launch" ? "checked" : "unchecked",
    cases,
  };
}
async function main() {
  let options: SmokeOptions;
  try {
    const args = process.argv.slice(2),
      values = new Map<string, string | boolean>();
    const switches = ["--online", "--dry-run"],
      valued = ["--base-url", "--mode", "--manifest", "--access-origin"];
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      requireThat(
        !values.has(key) && [...switches, ...valued].includes(key),
        "INVALID_ARGUMENTS",
      );
      if (switches.includes(key)) values.set(key, true);
      else {
        requireThat(
          args[i + 1] && !args[i + 1].startsWith("--"),
          "INVALID_ARGUMENTS",
        );
        values.set(key, args[++i]);
      }
    }
    requireThat(
      !(values.has("--online") && values.has("--dry-run")),
      "INVALID_ARGUMENTS",
    );
    const file = values.get("--manifest");
    let manifest: SmokeManifest | undefined;
    if (file !== undefined) {
      requireThat(
        typeof file === "string" && isAbsolute(file),
        "INVALID_ARGUMENTS",
      );
      manifest = manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
    }
    options = normalized({
      baseUrl: values.get("--base-url") as string,
      mode: (values.get("--mode") ?? "routes") as SmokeMode,
      online: values.has("--online"),
      manifest,
      accessOrigin: values.get("--access-origin") as string | undefined,
    });
    buildSmokePlan(options);
  } catch {
    console.log(JSON.stringify({ executed: false, code: "INVALID_ARGUMENTS" }));
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runSmoke(options);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ executed: false, code: "RUN_FAILED" }));
    process.exitCode = 1;
  }
}
if (import.meta.main) await main();
