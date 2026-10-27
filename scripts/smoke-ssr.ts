// SSR smoke test against the production build, served by `vite preview`.
// Usage: npm run build && npm run test:ssr
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { SITE_NAME } from "../src/lib/site.ts";

const TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const TOTAL_TIMEOUT_MS = 90_000;
const SETUP_TIMEOUT_MS = 120_000;

// Ask the OS for a free port. Another job on the same machine may hold 4173.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

if (!existsSync("dist")) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}

// A server function id from the server build. The TanStack compiler writes
// `createServerRpc({ id, name, filename }, ...)` for each server function.
function serverFnId(fnName: string, filename: string): string {
  const dir = "dist/server/assets";
  const ids = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(`${dir}/${name}`, "utf8");
    const pattern =
      /\bid:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*filename:\s*"([^"]+)"/g;
    for (const m of source.matchAll(pattern)) {
      if (m[2] === fnName && m[3] === filename) ids.add(m[1]);
    }
  }
  if (ids.size !== 1) {
    console.error(
      `FAIL: expected 1 server function id for ${fnName}, found ${ids.size}`,
    );
    process.exit(1);
  }
  return [...ids][0];
}

const ADMIN_FN_ID = serverFnId(
  "getAdminIdentity",
  "src/server/admin/identity.ts",
);
const PUBLIC_FN_ID = serverFnId(
  "getSiteInfo",
  "src/server/publication/site.ts",
);
const CREATE_WATCH_FN_ID = serverFnId(
  "createReaderWatch",
  "src/server/reader-watch/api.ts",
);
const BUILT_CONFIG = "dist/server/wrangler.json";
const builtConfig = JSON.parse(readFileSync(BUILT_CONFIG, "utf8"));
const ADMIN_EMAIL: string = builtConfig.vars.ADMIN_EMAIL;
if (!ADMIN_EMAIL) {
  console.error(`FAIL: no ADMIN_EMAIL in ${BUILT_CONFIG}`);
  process.exit(1);
}
// The test env has an empty CF_BEACON_TOKEN. Give the built worker a token, as
// a deploy would, so the check below sees the real <Beacon> in the HTML.
const BEACON_TOKEN = "t1";
builtConfig.vars.CF_BEACON_TOKEN = BEACON_TOKEN;
writeFileSync(BUILT_CONFIG, JSON.stringify(builtConfig, null, 2));

// `vite preview` reads the local D1 from a state directory that only this
// script uses (vite.config.ts reads AINEWS_SMOKE_STATE), so a developer's
// own local D1 under .wrangler/state is never touched. Start from an empty
// database, apply the migrations, then load the fixture rows that the page
// checks below depend on (tests/fixtures/publication/preview.sql).
const SMOKE_STATE = resolve(".wrangler/smoke-state");
function wrangler(args: string[]): void {
  const result = spawnSync("npx", ["wrangler", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    timeout: SETUP_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    console.error(`FAIL: wrangler ${args.join(" ")} (status ${result.status})`);
    process.exit(1);
  }
}
rmSync(SMOKE_STATE, { recursive: true, force: true });
wrangler([
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--env",
  "test",
  "--persist-to",
  SMOKE_STATE,
]);
wrangler([
  "d1",
  "execute",
  "DB",
  "--local",
  "--env",
  "test",
  "--persist-to",
  SMOKE_STATE,
  "--file",
  "tests/fixtures/publication/preview.sql",
]);

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(
  "npx",
  [
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(PORT),
    "--strictPort",
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    env: { ...process.env, AINEWS_SMOKE_STATE: SMOKE_STATE },
  },
);

function stop() {
  if (server.pid !== undefined && server.exitCode === null) {
    try {
      // Kill the whole process group: npx -> vite -> workerd.
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  clearTimeout(deadlineTimer);
  stop();
  process.exit(1);
}

// Hard limit for the whole script, so a hung request cannot block CI.
const deadlineTimer = setTimeout(() => {
  fail(`smoke test did not finish within ${TOTAL_TIMEOUT_MS / 1000}s`);
}, TOTAL_TIMEOUT_MS);

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      fail(`vite preview exited early with code ${server.exitCode}`);
    }
    try {
      await fetch(`${BASE}/`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail(`server did not start within ${TIMEOUT_MS / 1000}s`);
}

async function main() {
  await waitForServer();

  const home = await fetch(`${BASE}/`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await home.text();
  if (home.status !== 200) fail(`GET / returned ${home.status}`);
  const type = home.headers.get("content-type") ?? "";
  if (!type.includes("text/html")) fail(`GET / content-type is "${type}"`);
  if (!/<!doctype html/i.test(body)) fail("GET / has no <!doctype html>");
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
  if (title !== SITE_NAME) fail(`GET / <title> is "${title}"`);
  if (
    !Array.from(
      body.matchAll(/<header\b[\s\S]*?<\/header>/gi),
      (m) => m[0],
    ).some((h) =>
      Array.from(
        h.matchAll(/<a\b[^>]*\bhref="\/"[^>]*>([\s\S]*?)<\/a>/gi),
      ).some((m) => m[1].replace(/<[^>]*>/g, "").trim() === SITE_NAME),
    )
  ) {
    fail(`GET / has no header link "${SITE_NAME}" to /`);
  }
  const csp = home.headers.get("content-security-policy") ?? "";
  if (!csp.includes("default-src 'self'")) {
    fail(`GET / content-security-policy is "${csp}"`);
  }

  // Theme: the server always renders light. The inline init script is in
  // <head>, so a stored dark choice is applied before first paint (React
  // hoists the stylesheet link in front of it; a script that follows a
  // stylesheet runs before the first paint too). <html> itself carries no
  // data-theme.
  const htmlTag = body.match(/<html\b[^>]*>/i)?.[0] ?? "";
  if (!htmlTag || htmlTag.includes("data-theme")) {
    fail(`GET / <html> tag is "${htmlTag}"`);
  }
  const head = body.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const initAt = head.indexOf("pn:prefs:v1");
  if (initAt < 0) fail("GET / has no theme init script in <head>");
  const openAt = head.lastIndexOf("<script", initAt);
  const openTag =
    openAt < 0 ? "" : head.slice(openAt, head.indexOf(">", openAt));
  // type=, defer and async all postpone the script, so a stored dark choice
  // would flash light.
  if (!openTag || /\b(src|type|defer|async)\b/i.test(openTag)) {
    fail(`GET / theme init script tag is "${openTag}"`);
  }

  // The test env has empty Access vars, so every admin variant fails closed.
  // "//admin" is not sent: vite preview parses it as a protocol-relative URL,
  // so the worker sees http://admin/. "/%2Fadmin" reaches the worker and
  // decodes to "//admin". tests/edge.test.ts covers "//admin" directly.
  for (const path of ["/admin", "/Admin", "/%2Fadmin", "/%61dmin"]) {
    const res = await fetch(`${BASE}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    await res.text();
    if (res.status !== 403) fail(`GET ${path} returned ${res.status}`);
  }

  // An anonymous call to an admin server function goes through the real
  // TanStack dispatch and accessMiddleware: 403, and no admin data. It sends
  // the headers a same-origin browser call sends, so TanStack's default CSRF
  // middleware lets it through and the 403 comes from accessMiddleware.
  // The public function, called the same way, must return 200: this shows
  // the 403 is specific to the admin function.
  const callFn = (id: string) =>
    fetch(`${BASE}/_serverFn/${id}`, {
      headers: { "x-tsr-serverfn": "true", "Sec-Fetch-Site": "same-origin" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  const publicFn = await callFn(PUBLIC_FN_ID);
  await publicFn.text();
  if (publicFn.status !== 200) {
    fail(`server function getSiteInfo returned ${publicFn.status}`);
  }
  const adminFn = await callFn(ADMIN_FN_ID);
  const adminBody = await adminFn.text();
  if (adminFn.status !== 403) {
    fail(`server function getAdminIdentity returned ${adminFn.status}`);
  }
  if (adminBody.includes(ADMIN_EMAIL)) {
    fail("server function getAdminIdentity leaks ADMIN_EMAIL");
  }

  const bogus = await fetch(`${BASE}/?audience=bogus`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await bogus.text();
  if (bogus.status !== 200) {
    fail(`GET /?audience=bogus returned ${bogus.status}`);
  }

  // The reader watch entrance (#132), driven through the built worker with the
  // switch off (env.test): the real dispatch, the edge Origin check and the
  // validator run, then the handler refuses. Wire format: the body is what the
  // client sends, seroval's JSON for { data: { ... } }. This one is
  // { question: "Will agent protocols converge?", criteria: "A shipped
  // standard adopted by two vendors.", keywords: ["agent", "protocol"],
  // industrySlug: null }; it passes the validator, so the 403 below comes
  // from the handler's switch check, not from input checks.
  const CREATE_BODY =
    '{"t":{"t":10,"i":0,"p":{"k":["data"],"v":[{"t":10,"i":1,"p":{"k":["question","criteria","keywords","industrySlug"],"v":[{"t":1,"s":"Will agent protocols converge?"},{"t":1,"s":"A shipped standard adopted by two vendors."},{"t":9,"i":2,"a":[{"t":1,"s":"agent"},{"t":1,"s":"protocol"}],"o":0},{"t":2,"s":0}]},"o":0}]},"o":0},"f":127,"m":[]}';
  const postCreate = (body: string, origin: string | null) =>
    fetch(`${BASE}/_serverFn/${CREATE_WATCH_FN_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tsr-serverfn": "true",
        "Sec-Fetch-Site": "same-origin",
        ...(origin === null ? {} : { Origin: origin }),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  const siteOrigin: string = new URL(builtConfig.vars.SITE_URL).origin;
  const createOff = await postCreate(CREATE_BODY, siteOrigin);
  const createOffBody = await createOff.text();
  if (
    createOff.status !== 403 ||
    createOffBody.trim() !== '{"error":"reader_watch_disabled"}'
  ) {
    fail(
      `POST createReaderWatch with the switch off returned ${createOff.status} ${createOffBody.slice(0, 120)}`,
    );
  }
  // Input that fails the validator is refused with 400 before the handler.
  // Both refusals are plain JSON responses ({"error": code}); the client
  // receives them as a resolved value, not a thrown error (src/lib/follow.ts
  // handles both).
  const createBad = await postCreate(
    CREATE_BODY.replace("Will agent protocols converge?", "short"),
    siteOrigin,
  );
  const createBadBody = await createBad.text();
  if (
    createBad.status !== 400 ||
    createBadBody.trim() !== '{"error":"invalid_input"}'
  ) {
    fail(
      `POST createReaderWatch with bad input returned ${createBad.status} ${createBadBody.slice(0, 120)}`,
    );
  }
  console.log("ok: POST createReaderWatch is 403 reader_watch_disabled");

  // Public pages, against the fixture rows. Redirects are followed: an
  // invalid search param is redirected to its canonical URL.
  const page = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { res, text: await res.text() };
  };
  const DISCLAIMER = "Not investment advice";

  // The disclaimer text is also in the serialized loader data (<script>), so
  // count the rendered <Disclaimer> asides (role="note") outside of scripts.
  const notes = (html: string): string[] =>
    [
      ...html
        .replace(/<script\b[\s\S]*?<\/script>/gi, "")
        .matchAll(/<aside\b[^>]*role="note"[^>]*>[\s\S]*?<\/aside>/g),
    ].map((m) => m[0]);
  const EXPECTED_NOTES: Record<string, number> = {
    "/": 1,
    "/s/finance": 1,
    "/s/technology": 0,
    "/s/education": 0,
    "/s/industry": 0,
    // One Finance watch: its disclaimer, once.
    "/w": 1,
  };
  for (const [path, count] of Object.entries(EXPECTED_NOTES)) {
    const { res, text } = await page(path);
    if (res.status !== 200) fail(`GET ${path} returned ${res.status}`);
    const found = notes(text);
    if (found.length !== count) {
      fail(`GET ${path} has ${found.length} disclaimer notes, want ${count}`);
    }
    if (found.some((n) => !n.includes(DISCLAIMER))) {
      fail(`GET ${path} has a note without the Finance disclaimer`);
    }
  }

  const homePage = await page("/");
  // Site footer (#86): bodies are shown now, so it no longer says
  // "summaries only".
  if (!homePage.text.includes("Every story links to its original source.")) {
    fail("GET / lacks the footer 'Every story links to its original source.'");
  }
  if (homePage.text.includes("Summaries only")) {
    fail("GET / still says 'Summaries only'");
  }
  // Favicon and self-hosted fonts (#87): declared in <head>, served from
  // the same origin, never a 404.
  const homeHead = /<head>[\s\S]*?<\/head>/i.exec(homePage.text)?.[0] ?? "";
  for (const href of ["/favicon.svg", "/favicon.ico"]) {
    if (!new RegExp(`<link[^>]*rel="icon"[^>]*href="${href}"`).test(homeHead)) {
      fail(`GET / <head> has no icon link to ${href}`);
    }
  }
  for (const [path, type] of [
    ["/favicon.ico", "image/"],
    ["/favicon.svg", "image/svg+xml"],
    ["/fonts/literata-latin-400-normal.woff2", "font/woff2"],
    ["/fonts/newsreader-latin-600-normal.woff2", "font/woff2"],
  ]) {
    const res = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    await res.arrayBuffer();
    if (res.status !== 200) fail(`GET ${path} returned ${res.status}`);
    const got = res.headers.get("content-type") ?? "";
    if (!got.startsWith(type)) fail(`GET ${path} content-type is "${got}"`);
  }
  if (!homePage.text.includes("lg:columns-2")) {
    fail("GET / lacks 'lg:columns-2' multi-column flow layout");
  }
  if (!homePage.text.includes("break-inside-avoid")) {
    fail("GET / lacks 'break-inside-avoid' on sections");
  }

  const tech = await page("/s/technology");
  for (const needle of [
    // Analysis text, the editor's override, a correction, an evidence label.
    "Agent handshakes cost more than the work they start",
    "Editor-written title wins over the analysis",
    "wrong unit",
    "preprint",
    'aria-label="Sections"',
    'aria-current="page"',
    "Published",
    "Fetched",
  ]) {
    if (!tech.text.includes(needle))
      fail(`GET /s/technology lacks "${needle}"`);
  }

  // Unapproved articles, their corrections, and watch hits that are not
  // published are on no public page or feed.
  for (const path of [
    "/",
    "/s/technology",
    "/s/finance",
    "/s/education",
    "/w",
    "/w/tech-agent-protocols",
    "/w/finance-enforcement",
    "/rss/w/tech-agent-protocols.xml",
    "/rss/w/finance-enforcement.xml",
  ]) {
    const { res, text } = await page(path);
    if (res.status !== 200) fail(`GET ${path} returned ${res.status}`);
    if (text.includes("HIDDEN")) fail(`GET ${path} shows an unapproved item`);
  }

  // Reader watches (#132): the switch is off under env.test. /follow is a 404,
  // no page links it, and a reader watch's text is on no public page.
  const follow = await page("/follow");
  if (follow.res.status !== 404) {
    fail(`GET /follow returned ${follow.res.status}`);
  }
  if (follow.text.includes("Create watch")) {
    fail("GET /follow renders the form while the switch is off");
  }
  for (const path of ["/", "/w/", "/w", "/rss/w/tech-agent-protocols.xml"]) {
    const { res, text } = await page(path);
    if (res.status !== 200) fail(`GET ${path} returned ${res.status}`);
    if (text.includes("zq-reader-private-3")) {
      fail(`GET ${path} shows a reader watch`);
    }
    if (text.includes("/follow")) {
      fail(`GET ${path} links /follow while the switch is off`);
    }
  }

  // Topic watches: a header entry while active watches exist, a list page,
  // and the published hit on the watch page.
  if (!homePage.text.includes('data-nav="watches"')) {
    fail('GET / lacks the data-nav="watches" header link');
  }
  const watchList = await page("/w");
  for (const needle of [
    "When do agent protocols get cheaper to run?",
    "When does the Fed take a new enforcement action?",
  ]) {
    if (!watchList.text.includes(needle)) fail(`GET /w lacks "${needle}"`);
  }
  const techWatch = await page("/w/tech-agent-protocols");
  if (!techWatch.text.includes("Watch fixture: handshake overhead measured")) {
    fail("GET /w/tech-agent-protocols lacks its published hit");
  }
  // The article titles on a watch page link the reader page (#134); the
  // original link stays.
  const watchReaderId = /href="\/a\/(\d+)"/.exec(techWatch.text)?.[1];
  if (!watchReaderId) fail("GET /w/tech-agent-protocols has no /a/ links");
  if (!techWatch.text.includes('href="https://arxiv.org/abs/2610.30151"')) {
    fail("GET /w/tech-agent-protocols lacks the original link");
  }
  const watchReader = await page(`/a/${watchReaderId}`);
  if (watchReader.res.status !== 200) {
    fail(
      `GET /a/${watchReaderId} from the watch page returned ${watchReader.res.status}`,
    );
  }

  // Reader page /a/$articleId (#86). Every card links one; unapproved
  // articles are 404, never shown. The preview DB is rebuilt each run, so
  // ids 1..30 cover every fixture article, unapproved ones included.
  const readerIds = [...tech.text.matchAll(/href="\/a\/(\d+)"/g)].map(
    (m) => m[1],
  );
  if (readerIds.length === 0) fail("GET /s/technology has no /a/ links");
  for (const id of new Set(readerIds)) {
    const { res, text } = await page(`/a/${id}`);
    if (res.status !== 200) fail(`GET /a/${id} returned ${res.status}`);
    if (!text.includes('rel="canonical"'))
      fail(`GET /a/${id} has no canonical link`);
    if (text.includes("HIDDEN"))
      fail(`GET /a/${id} shows an unapproved article`);
  }
  for (let n = 1; n <= 30; n++) {
    const { res, text } = await page(`/a/${n}`);
    if (res.status === 200 && text.includes("HIDDEN"))
      fail(`GET /a/${n} shows an unapproved article`);
  }
  const finPage = await page("/s/finance");
  const finId = /href="\/a\/(\d+)"/.exec(finPage.text)?.[1];
  if (!finId) fail("GET /s/finance has no /a/ links");
  const finReader = await page(`/a/${finId}`);
  const finNotes = notes(finReader.text);
  if (finNotes.length !== 1 || !finNotes[0].includes(DISCLAIMER)) {
    fail(`GET /a/${finId} has ${finNotes.length} disclaimer notes, want 1`);
  }
  for (const path of ["/a/999999", "/a/abc"]) {
    const { res } = await page(path);
    if (res.status !== 404) fail(`GET ${path} returned ${res.status}`);
  }

  const none = await page("/s/nope");
  if (none.res.status !== 404) fail(`GET /s/nope returned ${none.res.status}`);

  const noEvent = await page("/e/999999");
  if (noEvent.res.status !== 404)
    fail(`GET /e/999999 returned ${noEvent.res.status}`);

  // Event page (#115, #131): the five artifact cards each list their source
  // articles with a reader link and both times. Scripts are cut out first:
  // the loader data in them repeats the attribute text.
  const eventPage = await page("/e/1");
  if (eventPage.res.status !== 200)
    fail(`GET /e/1 returned ${eventPage.res.status}`);
  const eventHtml = eventPage.text.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  const sourceBlocks = [
    ...eventHtml.matchAll(
      /<footer\b[^>]*aria-label="Artifact sources"[^>]*>[\s\S]*?<\/footer>/g,
    ),
  ].map((m) => m[0]);
  if (sourceBlocks.length !== 5) {
    fail(`GET /e/1 has ${sourceBlocks.length} Artifact sources blocks, want 5`);
  }
  for (const block of sourceBlocks) {
    for (const needle of ['href="/a/', "Published", "Fetched"]) {
      if (!block.includes(needle)) {
        fail(`GET /e/1 Artifact sources block lacks "${needle}"`);
      }
    }
  }
  console.log("ok: GET /e/1 has 5 Artifact sources blocks");

  // Invalid search params: TanStack redirects (307) to the canonical URL
  // without them. The redirect target serves page 1.
  const oddPath = "/s/technology?page=-3";
  const oddRes = await fetch(`${BASE}${oddPath}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  await oddRes.text();
  if (oddRes.status !== 307) fail(`GET ${oddPath} returned ${oddRes.status}`);
  const target = new URL(oddRes.headers.get("location") ?? "", BASE);
  if (target.pathname !== "/s/technology" || target.search !== "") {
    fail(`GET ${oddPath} redirects to ${target.pathname}${target.search}`);
  }
  const odd = await page(`${target.pathname}${target.search}`);
  if (odd.res.status !== 200) {
    fail(
      `GET ${target.pathname} after the redirect returned ${odd.res.status}`,
    );
  }
  if (
    !odd.text.includes("Agent handshakes cost more than the work they start")
  ) {
    fail("GET /s/technology after the redirect is not page 1");
  }

  // The audience parameter is gone (#87 A2): a URL that still carries it is
  // ignored. The page answers 200 with no redirect, and no link on it carries
  // the parameter.
  for (const path of [
    "/?audience=professional",
    "/s/technology?audience=professional",
    "/e/1?audience=professional",
    `/a/${finId}?audience=professional`,
  ]) {
    const res = await fetch(`${BASE}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = (await res.text()).replace(
      /<script\b[\s\S]*?<\/script>/gi,
      "",
    );
    if (res.status !== 200) fail(`GET ${path} returned ${res.status}`);
    if (/href="[^"]*audience=/.test(text)) {
      fail(`GET ${path} has a link that carries audience=`);
    }
  }
  console.log(
    "ok: ?audience= is ignored (200, no redirect, no audience links)",
  );

  // Event page anchor nav: every link points at an id on the page.
  const navHtml =
    /<nav\b[^>]*aria-label="On this page"[^>]*>[\s\S]*?<\/nav>/.exec(
      eventHtml,
    )?.[0];
  if (!navHtml) fail("GET /e/1 has no On this page nav");
  const navIds = [...(navHtml ?? "").matchAll(/href="#([^"]+)"/g)].map(
    (m) => m[1],
  );
  if (navIds.length === 0) fail("GET /e/1 anchor nav has no links");
  for (const id of navIds) {
    if (!eventHtml.includes(`id="${id}"`)) {
      fail(`GET /e/1 anchor nav links to #${id}, which is not on the page`);
    }
  }
  console.log(`ok: GET /e/1 anchor nav links ${navIds.length} sections`);

  // The built worker has CF_BEACON_TOKEN (set above): the beacon script is in
  // the HTML, outside of the serialized loader data.
  for (const path of ["/", "/s/technology"]) {
    const { text } = await page(path);
    const tag = text.match(/<script\b[^>]*beacon\.min\.js[^>]*>/)?.[0] ?? "";
    if (!tag.includes("static.cloudflareinsights.com/beacon.min.js")) {
      fail(`GET ${path} has no beacon script`);
    }
    if (!tag.includes(`&quot;token&quot;:&quot;${BEACON_TOKEN}&quot;`)) {
      fail(`GET ${path} beacon script lacks the token`);
    }
  }

  // RSS.
  const rss = async (path: string) => {
    const { res, text } = await page(path);
    return {
      status: res.status,
      type: res.headers.get("content-type") ?? "",
      text,
    };
  };
  const techFeed = await rss("/rss/technology.xml");
  if (techFeed.status !== 200)
    fail(`GET /rss/technology.xml returned ${techFeed.status}`);
  if (!techFeed.type.startsWith("application/rss+xml")) {
    fail(`GET /rss/technology.xml content-type is "${techFeed.type}"`);
  }
  if (
    !techFeed.text.includes("SR-1 Freedom") ||
    techFeed.text.includes("HIDDEN")
  ) {
    fail("GET /rss/technology.xml has the wrong items");
  }
  if (
    !techFeed.text.includes("/a/") ||
    !techFeed.text.includes('<guid isPermaLink="false">')
  ) {
    fail("GET /rss/technology.xml items do not link /a/ or lost their guid");
  }
  const finFeed = await rss("/rss/finance.xml");
  const channel = finFeed.text.split("<item>")[0];
  if (finFeed.status !== 200 || !channel.includes(DISCLAIMER)) {
    fail("GET /rss/finance.xml channel description has no disclaimer");
  }
  const items = finFeed.text.split("<item>").slice(1);
  if (items.length === 0 || items.some((i) => !i.includes(DISCLAIMER))) {
    fail("GET /rss/finance.xml has an item without the disclaimer");
  }
  if (finFeed.text.includes("HIDDEN"))
    fail("GET /rss/finance.xml shows an unapproved item");
  const noFeed = await rss("/rss/nope.xml");
  if (noFeed.status !== 404)
    fail(`GET /rss/nope.xml returned ${noFeed.status}`);

  // Private reader feed: an unknown well-formed token is a 404 that keeps
  // the private headers through the real edge (#132).
  const privatePath = `/rss/p/${"A".repeat(43)}.xml`;
  const privateFeed = await page(privatePath);
  if (privateFeed.res.status !== 404)
    fail(`GET ${privatePath} returned ${privateFeed.res.status}`);
  for (const [name, value] of [
    ["cache-control", "private, no-store"],
    ["referrer-policy", "no-referrer"],
    ["x-robots-tag", "noindex, nofollow"],
  ] as const) {
    const got = privateFeed.res.headers.get(name);
    if (got !== value) fail(`GET ${privatePath} ${name} is "${got}"`);
  }

  // Digest pages & RSS
  const digestPage = await page("/digest/technology/2026-10-21");
  if (digestPage.res.status !== 200) {
    fail(`GET /digest/technology/2026-10-21 returned ${digestPage.res.status}`);
  }
  if (!digestPage.text.includes("Preview tech digest synthesis.")) {
    fail("GET /digest/technology/2026-10-21 lacks synthesis intro");
  }

  const badDateDigest = await page("/digest/technology/not-a-date");
  if (badDateDigest.res.status !== 404) {
    fail(
      `GET /digest/technology/not-a-date returned ${badDateDigest.res.status}`,
    );
  }

  const missingDigest = await page("/digest/technology/2099-01-01");
  if (missingDigest.res.status !== 404) {
    fail(
      `GET /digest/technology/2099-01-01 returned ${missingDigest.res.status}`,
    );
  }

  const digestRss = await rss("/rss/digest/technology.xml");
  if (digestRss.status !== 200) {
    fail(`GET /rss/digest/technology.xml returned ${digestRss.status}`);
  }
  if (!digestRss.type.startsWith("application/rss+xml")) {
    fail(`GET /rss/digest/technology.xml content-type is "${digestRss.type}"`);
  }
  if (!digestRss.text.includes("Daily Digest — 2026-10-21")) {
    fail("GET /rss/digest/technology.xml lacks digest item");
  }

  console.log("PASS: SSR smoke test");
  clearTimeout(deadlineTimer);
  stop();
  process.exit(0);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
