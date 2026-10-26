import { afterEach, expect, test, vi } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSmokePlan, runSmoke } from "../scripts/smoke.ts";
import type { SmokeManifest, SmokeOptions } from "../scripts/smoke.ts";

const script = fileURLToPath(new URL("../scripts/smoke.ts", import.meta.url));
const base = "https://news.example";
const sections = ["technology", "education", "industry", "finance"];
const manifest: SmokeManifest = {
  eventIds: [7],
  watchSlugs: ["chip-watch"],
  funding: true,
  digests: [
    { section: "technology", date: "2024-02-29", kind: "daily" },
    { section: "industry", date: "2024-02-26", kind: "weekly" },
  ],
};
const options: SmokeOptions = { baseUrl: base, mode: "routes", online: true };
const notice = "Not investment advice";
const temps: string[] = [];
function temporary() {
  const p = mkdtempSync(join(tmpdir(), "ainews-smoke-"));
  temps.push(p);
  return p;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const p of temps.splice(0)) rmSync(p, { recursive: true });
});
// Mirrors the structure rendered by the #23 route: ul/li cards in the Rounds
// section, or one empty paragraph there. It renders no table.
function funding(cards = 1): string {
  const rounds = cards
    ? `<ul>${Array.from({ length: cards }, (_, i) => `<li><h3>Company ${i + 1}</h3><span>$5,000,000</span></li>`).join("")}</ul>`
    : "<p>No funding rounds match.</p>";
  return `<!DOCTYPE html><html><head><title>Personal News</title></head><body><header>Personal News</header><main><div data-section="finance"><h1>Funding Round Tracker</h1><aside role="note">${notice}</aside><section aria-label="Trends"><ul><li><a href="/funding?sector=fintech">fintech</a></li></ul></section><section aria-label="Rounds"><h2>Reported rounds</h2>${rounds}</section></div></main></body></html>`;
}
function html(path: string): string {
  if (path === "/funding") return funding();
  const section = path.split("/")[2];
  const heading = path.startsWith("/digest/")
    ? `${section} ${path.includes("weekly") ? "Weekly" : "Daily"} Digest · ${path.split("/")[3].split("?")[0]}`
    : path.startsWith("/s/")
      ? section
      : "Sample story";
  return `<!DOCTYPE html><html><head><title>Personal News</title></head><body><header>Personal News</header><main>
    ${sections.map((s) => `<a href="/s/${s}">${s}</a>`).join("")}
    <div data-section="${sections.includes(section) ? section : "technology"}"><h1>${heading}</h1>
    <p>${notice}</p><h2>Timeline</h2><h2>Material Developments</h2><p>Criterion for Update:</p>
    <a href="/rss/w/chip-watch.xml">RSS Feed</a><h2>Top Developments</h2></div></main></body></html>`;
}
function rss(path: string, items = true): string {
  const watch = path.startsWith("/rss/w/");
  const digest = path.startsWith("/rss/digest/");
  const section = path.split("/").at(-1)!.replace(".xml", "");
  const channelLink = watch ? "/w/chip-watch" : `/s/${section}`;
  const link = watch
    ? `${base}/e/7`
    : digest
      ? `${base}/digest/${section}/2024-02-26?kind=weekly`
      : "https://outside.example/article";
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Personal News — ${watch ? "Watch: Sample" : section}${digest ? " Digests" : ""}</title><link>${base}${channelLink}</link><description>Approved stories ${notice}</description>${items ? `<item><title>Story</title><guid isPermaLink="false">007</guid><link>${link}</link><description>Summary ${notice}</description><pubDate>Thu, 29 Feb 2024 00:00:00 GMT</pubDate></item>` : ""}</channel></rss>`;
}
function response(path: string, items = true): Response {
  if (path.includes("__smoke_missing__"))
    return new Response("Missing", { status: 404 });
  if (path === "/admin") return new Response(null, { status: 403 });
  const xml = path.startsWith("/rss/");
  return new Response(xml ? rss(path, items) : html(path), {
    headers: {
      "content-type": xml
        ? "application/rss+xml; charset=utf-8"
        : "text/html; charset=utf-8",
    },
  });
}
function fake(change?: (path: string) => Response | undefined) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const u = new URL(String(input));
    expect(u.origin).toBe(base);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    const p = u.pathname + u.search;
    return change?.(p) ?? response(p);
  });
}
function cli(args: string[], cwd = temporary(), preload?: string) {
  return spawnSync(
    process.execPath,
    [...(preload ? ["--import", preload] : []), script, ...args],
    { cwd, encoding: "utf8", timeout: 5000 },
  );
}
async function rejectsBody(path: string, body: string, opts = options) {
  const type = path.startsWith("/rss/") ? "application/rss+xml" : "text/html";
  const result = await runSmoke(opts, {
    fetch: fake((p) =>
      p === path
        ? new Response(body, { headers: { "content-type": type } })
        : undefined,
    ),
  });
  expect(result.ok).toBe(false);
}
const argBase = ["--base-url", base];

test("dry_run_never_fetches_and_import_has_no_side_effect", async () => {
  const fetcher = fake();
  vi.stubGlobal("fetch", fetcher);
  await import("../scripts/smoke.ts");
  expect(fetcher).not.toHaveBeenCalled();
  const result = await runSmoke(
    { ...options, online: false },
    { fetch: fetcher },
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.contentReadiness).toBe("unchecked");
  expect(result.cases).toHaveLength(16);
  expect(result.cases.every((c) => c.code === "NOT_EXECUTED")).toBe(true);
  const preload = join(temporary(), "no-effects.mjs");
  writeFileSync(
    preload,
    'globalThis.fetch = () => { throw new Error("NETWORK_SENTINEL"); };',
  );
  const imported = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(script)})`,
    ],
    { cwd: temporary(), encoding: "utf8" },
  );
  expect(imported.status).toBe(0);
  expect(imported.stdout + imported.stderr).toBe("");
  const run = cli(argBase, undefined, preload);
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout).executed).toBe(false);
  expect(run.stdout).not.toContain("PASS");
});

test("requires_explicit_origin_and_rejects_credentials", async () => {
  for (const baseUrl of [
    "",
    "http://example.com",
    "https://user:pass@news.example",
    "https://news.example/path",
    "https://news.example?",
    "https://news.example/#",
    "https://news.example\\evil",
    " http://127.0.0.1",
    "http://127.1",
    "http://0x7f000001",
    "http://localhost",
    "file:///tmp/x",
  ]) {
    expect(() => buildSmokePlan({ ...options, baseUrl })).toThrow();
  }
  for (const baseUrl of [
    base,
    "https://news.example/",
    "https://news.example:443/",
    "http://127.0.0.1:1234",
    "http://[::1]:1234",
  ])
    expect(buildSmokePlan({ ...options, baseUrl })).toHaveLength(16);
  for (const args of [
    [],
    [...argBase, "--unknown"],
    [...argBase, "extra"],
    [...argBase, "--online", "--dry-run"],
    [...argBase, "--online", "--online"],
    [...argBase, "--base-url", base],
    [...argBase, "--mode", "bogus"],
    [...argBase, "--manifest", "relative.json"],
    [...argBase, "--access-origin", "http://127.0.0.1"],
  ])
    expect(cli(args).status).toBe(2);
  const fetcher = fake();
  const bad = [
    { eventIds: [0] },
    { eventIds: [Number.MAX_SAFE_INTEGER + 1] },
    { watchSlugs: ["../admin"] },
    { watchSlugs: ["a%2fb"] },
    { digests: [{ section: "technology", date: "2023-02-29", kind: "daily" }] },
    { digests: [{ section: "finance", date: "2024-02-29", kind: "monthly" }] },
    { urls: ["/_serverFn/x"] },
    { funding: "true" },
    { digests: [{ section: "unknown", date: "2024-01-01", kind: "daily" }] },
    { eventIds: Array.from({ length: 49 }, (_, i) => i + 1) },
  ];
  for (const value of bad) {
    await expect(
      runSmoke(
        { ...options, manifest: value as unknown as SmokeManifest },
        { fetch: fetcher },
      ),
    ).rejects.toThrow();
    const p = join(temporary(), "bad.json");
    writeFileSync(p, JSON.stringify(value));
    expect(cli([...argBase, "--manifest", p]).status).toBe(2);
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    buildSmokePlan({ ...options, manifest: { ...manifest, eventIds: [7, 7] } }),
  ).toEqual(buildSmokePlan({ ...options, manifest }));
});

test("works_from_unrelated_cwd_with_absolute_manifest", () => {
  const file = join(temporary(), "manifest.json");
  writeFileSync(file, JSON.stringify(manifest));
  const args = [...argBase, "--manifest", file, "--dry-run"];
  const a = cli(args),
    b = cli(args, fileURLToPath(new URL("..", import.meta.url)));
  expect(a.status).toBe(0);
  expect(b.status).toBe(0);
  expect(a.stdout).toBe(b.stdout);
  expect(JSON.parse(a.stdout).cases).toHaveLength(22);
});

test("passes_realistic_html_and_all_three_rss_families", async () => {
  const fetcher = fake();
  const result = await runSmoke({ ...options, manifest }, { fetch: fetcher });
  expect(result.ok).toBe(true);
  expect(result.cases).toHaveLength(22);
  expect(fetcher).toHaveBeenCalledTimes(22);
  expect(result.cases.some((c) => c.path.endsWith("?kind=weekly"))).toBe(true);
  expect(result.cases.some((c) => c.path === "/rss/w/chip-watch.xml")).toBe(
    true,
  );
});

test("validates_real_funding_cards_and_empty_state_not_a_table", async () => {
  const code = async (body: string) =>
    (
      await runSmoke(
        { ...options, manifest },
        {
          fetch: fake((p) =>
            p === "/funding"
              ? new Response(body, { headers: { "content-type": "text/html" } })
              : undefined,
          ),
        },
      )
    ).cases.find((c) => c.path === "/funding")!.code;
  for (const cards of [0, 1, 3])
    expect(await code(funding(cards))).toBe("PASS");
  const rounds = /<section aria-label="Rounds">[\s\S]*<\/section>/;
  for (const body of [
    funding().replace(rounds, "<table><tr><th>Company</th></tr></table>"),
    funding().replace(rounds, ""),
    funding().replace(/<section aria-label="Trends">[\s\S]*?<\/section>/, ""),
    funding().replace("<h3>Company 1</h3>", "<span>Company 1</span>"),
    funding(0).replace("<p>No funding rounds match.</p>", ""),
    funding(0).replace(
      "<p>No funding rounds match.</p>",
      "<script>No funding rounds match.</script>",
    ),
    funding(0)
      .replace("<p>No funding rounds match.</p>", "")
      .replace("<ul><li>", "<p>No funding rounds match.</p><ul><li>"),
  ])
    expect(await code(body)).toBe("HTML_FUNDING");
  expect(await code(funding().replace(notice, ""))).toBe("FINANCE_NOTICE");
});

test("routes_mode_does_not_claim_content_readiness", async () => {
  const r = await runSmoke(options, { fetch: fake((p) => response(p, false)) });
  expect(r.ok).toBe(true);
  expect(r.contentReadiness).toBe("unchecked");
});

test("launch_requires_four_nonempty_sections_and_complete_manifest", async () => {
  const launch = { ...options, mode: "launch" as const, manifest };
  expect((await runSmoke(launch, { fetch: fake() })).contentReadiness).toBe(
    "checked",
  );
  for (const partial of [
    undefined,
    { ...manifest, eventIds: [] },
    { ...manifest, watchSlugs: [] },
    { ...manifest, funding: false },
    { ...manifest, digests: manifest.digests.slice(1) },
    { ...manifest, digests: manifest.digests.slice(0, 1) },
    {
      ...manifest,
      digests: manifest.digests.map((d) => ({ ...d, section: "education" })),
    },
  ]) {
    const fetcher = fake();
    const r = await runSmoke(
      { ...launch, manifest: partial },
      { fetch: fetcher },
    );
    expect(r.ok).toBe(false);
    expect(r.contentReadiness).toBe("unchecked");
    expect(r.cases).toHaveLength(
      buildSmokePlan({ ...launch, manifest: partial }).length,
    );
    expect(fetcher).not.toHaveBeenCalled();
  }
  for (const s of sections)
    expect(
      (
        await runSmoke(launch, {
          fetch: fake((p) =>
            p === `/rss/${s}.xml` ? response(p, false) : undefined,
          ),
        })
      ).ok,
    ).toBe(false);
  expect(
    (
      await runSmoke(launch, {
        fetch: fake((p) =>
          p === "/funding" ? new Response(null, { status: 404 }) : undefined,
        ),
      })
    ).ok,
  ).toBe(false);
  const file = join(temporary(), "incomplete.json");
  writeFileSync(file, "{}");
  expect(
    cli([...argBase, "--mode", "launch", "--online", "--manifest", file])
      .status,
  ).toBe(1);
});

test("rejects_xml_errors_html_disguised_as_rss_and_duplicate_guids", async () => {
  const valid = rss("/rss/technology.xml");
  for (const body of [
    "<rss><channel></rss>",
    html("/"),
    '<!DOCTYPE rss [<!ENTITY secret "x">]>' + valid,
    '<!ENTITY secret "x">' + valid,
    valid.replace("?><rss", '?><!DOCTYPE rss [<!ENTITY x "value">]><rss'),
    valid.replace("</channel>", "</channe>"),
    valid.replace('version="2.0"', 'version="1.0"'),
    valid.replace(
      '<guid isPermaLink="false">007</guid>',
      "<guid>x</guid><guid>x</guid>",
    ),
    valid.replace(
      "</channel>",
      valid.match(/<item>.*<\/item>/)![0] + "</channel>",
    ),
    valid.replace("Thu, 29 Feb 2024 00:00:00 GMT", "bad date"),
    valid.replace(/<title>.*?<\/title>/, ""),
    valid.replace(/<description>.*?<\/description>/, ""),
    valid.replace(/<link>.*?<\/link>/, ""),
    valid.replace("<rss", "<html").replace("</rss>", "</html>"),
  ]) {
    await rejectsBody("/rss/technology.xml", body);
  }
});

test("checks_finance_disclaimer_outside_serialized_scripts", async () => {
  for (const path of [
    "/s/finance",
    "/rss/finance.xml",
    "/rss/digest/finance.xml",
  ]) {
    for (const replace of [
      (s: string) => s.replace(notice, ""),
      (s: string) =>
        s.includes("<rss")
          ? s.replace(`Summary ${notice}`, "Summary")
          : s.replaceAll(notice, `<style>${notice}</style>`),
      (s: string) => s.replaceAll(notice, `<script>${notice}</script>`),
    ]) {
      const xml = path.startsWith("/rss/");
      const body = replace(xml ? rss(path) : html(path));
      await rejectsBody(path, body);
    }
  }
  for (const path of [
    "/",
    "/s/technology",
    "/e/7",
    "/w/chip-watch",
    "/digest/technology/2024-02-29",
    "/funding",
  ]) {
    const body = `<!DOCTYPE html><html><body><script>${html(path)}</script><main></main></body></html>`;
    await rejectsBody(path, body, { ...options, manifest });
  }
});

test("rejects_wrong_page_semantics_status_and_media", async () => {
  for (const body of [
    html("/s/technology").replace("<!DOCTYPE html>", ""),
    html("/s/technology").replace(
      'data-section="technology"',
      'data-section="education"',
    ),
    html("/s/technology").replace("<h1>technology</h1>", "<h1>education</h1>"),
  ])
    await rejectsBody("/s/technology", body);
  for (const path of [
    "/e/7",
    "/w/chip-watch",
    "/digest/technology/2024-02-29",
    "/funding",
  ])
    await rejectsBody(
      path,
      html(path).replace(
        /Timeline|Criterion for Update:|Daily Digest|Funding Round Tracker/g,
        "Missing",
      ),
      { ...options, manifest },
    );
  for (const status of [201, 204, 301, 500])
    expect(
      (
        await runSmoke(options, {
          fetch: fake((p) =>
            p === "/"
              ? new Response(status === 204 ? null : html(p), {
                  status,
                  headers: { "content-type": "text/html" },
                })
              : undefined,
          ),
        })
      ).ok,
    ).toBe(false);
  expect(
    (
      await runSmoke(options, {
        fetch: fake((p) =>
          p === "/"
            ? new Response(html(p), {
                headers: { "content-type": "application/json" },
              })
            : undefined,
        ),
      })
    ).ok,
  ).toBe(false);
});

test("does_not_follow_redirects_or_external_article_links", async () => {
  const fetcher = fake((p) =>
    p === "/"
      ? new Response(null, {
          status: 302,
          headers: { location: "https://poison.example/token" },
        })
      : undefined,
  );
  expect((await runSmoke(options, { fetch: fetcher })).ok).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(16);
  for (const link of [
    "https://poison.example/digest/technology/2024-02-29",
    `${base}/_serverFn/x`,
    `${base}/digest/technology/2024-02-30`,
    `${base}/digest/technology/2024-02-29?other=x`,
    `${base}/digest/education/2024-02-29`,
  ]) {
    await rejectsBody(
      "/rss/digest/technology.xml",
      rss("/rss/digest/technology.xml").replace(
        /<item>([\s\S]*?)<link>.*?<\/link>/,
        `<item>$1<link>${link}</link>`,
      ),
    );
  }
});

test("admin_denial_is_not_a_followed_login_200", async () => {
  for (const status of [401, 403, 302, 303, 307]) {
    expect(
      (
        await runSmoke(
          { ...options, accessOrigin: "https://access.example" },
          {
            fetch: fake((p) =>
              p === "/admin"
                ? new Response(null, {
                    status,
                    headers: {
                      location:
                        "https://access.example/cdn-cgi/access/login?token=SENTINEL",
                    },
                  })
                : undefined,
            ),
          },
        )
      ).ok,
    ).toBe(true);
  }
  for (const [status, location, accessOrigin] of [
    [200, "", undefined],
    [308, "https://access.example/login", "https://access.example"],
    [302, "https://access.example/login", undefined],
    [302, "https://access.example.evil/login", "https://access.example"],
    [302, "https://u:p@access.example/login", "https://access.example"],
    [302, "http://access.example/login", "https://access.example"],
    [302, "/login", "https://access.example"],
  ] as const) {
    const r = await runSmoke(
      { ...options, accessOrigin },
      {
        fetch: fake((p) =>
          p === "/admin"
            ? new Response(null, { status, headers: { location } })
            : undefined,
        ),
      },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  }
  expect(
    (
      await runSmoke(options, {
        fetch: fake((p) =>
          p.includes("__smoke_missing__") ? response("/") : undefined,
        ),
      })
    ).ok,
  ).toBe(false);
});

test("timeouts_caps_and_errors_never_print_sensitive_text", async () => {
  const sentinel = "SECRET_BODY_HEADER_TOKEN";
  let cancelled = 0;
  const over = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(1024 * 1024));
          c.enqueue(new Uint8Array(1024 * 1024 + 1));
        },
        cancel() {
          cancelled++;
        },
      }),
    );
  const r = await runSmoke(options, {
    fetch: fake((p) => (p === "/" ? over() : undefined)),
  });
  expect(r.ok).toBe(false);
  expect(cancelled).toBe(1);
  expect(r.cases[0].code).toBe("BODY_LIMIT");
  const error = await runSmoke(options, {
    fetch: vi.fn(async () => {
      throw new Error(sentinel);
    }),
  });
  expect(error.ok).toBe(false);
  expect(JSON.stringify(error)).not.toContain(sentinel);
  const failing = join(temporary(), "error.mjs");
  writeFileSync(
    failing,
    `globalThis.fetch = async () => { throw new Error("${sentinel}"); };`,
  );
  const failed = cli([...argBase, "--online"], undefined, failing);
  expect(failed.status).toBe(1);
  expect(failed.stdout + failed.stderr).not.toContain(sentinel);
  vi.useFakeTimers();
  let active = 0,
    peak = 0,
    aborts = 0;
  const hanging: typeof fetch = async (_u, init) => {
    active++;
    peak = Math.max(peak, active);
    init?.signal?.addEventListener("abort", () => {
      active--;
      aborts++;
    });
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    );
  };
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let slowDone = false;
  const slow = runSmoke(options, {
    fetch: fake((p) =>
      p === "/"
        ? new Response(
            new ReadableStream({
              start(c) {
                stream = c;
              },
            }),
          )
        : undefined,
    ),
  }).finally(() => {
    slowDone = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(9000);
    stream!.enqueue(new TextEncoder().encode("partial"));
    await vi.advanceTimersByTimeAsync(1001);
    // Finite virtual time must settle the run; never wait on a hung stream.
    expect(slowDone).toBe(true);
    expect((await slow).cases[0].code).toBe("REQUEST_TIMEOUT");
  } finally {
    try {
      stream?.close();
    } catch {
      // already cancelled by the deadline
    }
  }
  const timed = runSmoke(
    {
      ...options,
      manifest: {
        ...manifest,
        eventIds: Array.from({ length: 40 }, (_, i) => i + 1),
      },
    },
    { fetch: hanging },
  );
  let timedDone = false;
  void timed.finally(() => {
    timedDone = true;
  });
  await vi.advanceTimersByTimeAsync(120_001);
  await vi.runAllTimersAsync();
  expect(timedDone).toBe(true);
  const result = await timed;
  expect(result.ok).toBe(false);
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(aborts).toBe(24);
  expect(result.cases.some((c) => c.code === "TOTAL_TIMEOUT")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  const preload = join(temporary(), "hang.mjs");
  writeFileSync(
    preload,
    'globalThis.fetch = async u => new URL(u).pathname === "/" ? new Response(new ReadableStream()) : new Response(null, {status:403});',
  );
  const child = spawn(
    process.execPath,
    ["--import", preload, script, ...argBase, "--online"],
    { cwd: temporary(), stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
  );
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  const status = await new Promise<number | null>((resolve) =>
    child.on("exit", resolve),
  );
  expect(status).toBe(1);
  expect(output).toContain("REQUEST_TIMEOUT");
  expect(output).not.toContain(sentinel);
}, 100_000);
