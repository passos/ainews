// Real calls for the fetch ladder (#6): one HTML page and one PDF through
// env.AI.toMarkdown() (rung 2), and one Jina Reader read (rung 3). Tests
// only use fakes, so this is the only check of the toMarkdown arguments and
// of the Jina request headers and response format. The Jina read costs a
// little money; it calls the transport directly, without the ledger or the
// budget (the production jina cap is 0).
//
// Usage (env file path is up to the caller):
//   SMOKE_BINDING_AUTH=deploy node --env-file=/abs/path/.env.prod scripts/smoke-body.ts
//
// Needs JINA_API_KEY. Binding path: getPlatformProxy() on the top-level
// wrangler.jsonc (env.test has no AI binding). Wrangler auth:
//   SMOKE_BINDING_AUTH=deploy (default) keeps CLOUDFLARE_API_TOKEN as the
//   caller set it (the ainews-deploy token) and requires it;
//   SMOKE_BINDING_AUTH=login removes CLOUDFLARE_API_TOKEN, so wrangler uses
//   the `wrangler login` session.
// Optional: SMOKE_HTML_URL (default: the arXiv abstract page of the PDF).
// robots.txt is checked before each page request, and its Crawl-delay is
// kept between requests to the same host. Keys are never printed.
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
// Explicit extensions: Node resolves these files directly.
import { fetchLimited, USER_AGENT } from "../src/lib/http.ts";
import { robotsFromResponse } from "../src/lib/robots.ts";
import { costMicros } from "../src/providers/budget.ts";
import { DEFAULT_PRICES, DEFAULT_SLOTS } from "../src/providers/defaults.ts";
import { jinaTransport, parseJinaText } from "../src/providers/jina.ts";
import type { JinaRaw } from "../src/providers/jina.ts";
import { toMarkdown } from "../src/providers/tomarkdown.ts";
import type { MarkdownMime } from "../src/providers/tomarkdown.ts";
import { TransportHttpError } from "../src/providers/transport.ts";

const PDF_URL = "https://arxiv.org/pdf/2412.20138";
const HTML_URL =
  process.env.SMOKE_HTML_URL ?? "https://arxiv.org/abs/2412.20138";
/** Same as PAGE_ACCEPT and MAX_BODY_BYTES in src/pipeline/body/ladder.ts. */
const ACCEPT = "text/markdown, text/html;q=0.9, application/pdf;q=0.8";
const MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW = 300;
const CONFIG_PATH = fileURLToPath(
  new URL("../wrangler.jsonc", import.meta.url),
);

interface Outcome {
  step: string;
  ok: boolean;
  detail: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}.`);
    process.exit(2);
  }
  return value;
}

const jinaKey = required("JINA_API_KEY");
const bindingAuth = process.env.SMOKE_BINDING_AUTH ?? "deploy";
if (bindingAuth !== "deploy" && bindingAuth !== "login") {
  console.error('SMOKE_BINDING_AUTH must be "deploy" or "login".');
  process.exit(2);
}
if (bindingAuth === "deploy") required("CLOUDFLARE_API_TOKEN");
else delete process.env.CLOUDFLARE_API_TOKEN;

function describeError(error: unknown): string {
  if (error instanceof TransportHttpError) {
    return `HTTP ${error.status}: ${error.body.slice(0, PREVIEW)}`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/** Next allowed request time per host, from Crawl-delay. */
const nextAt = new Map<string, number>();

/** Returns null if robots.txt disallows the URL. */
async function politeFetch(url: string) {
  const target = new URL(url);
  const robotsRes = await fetchLimited(
    `${target.origin}/robots.txt`,
    {},
    512 * 1024,
    fetch,
  ).catch(() => null);
  const robots = robotsFromResponse(
    robotsRes?.res.status ?? 0,
    robotsRes ? new TextDecoder().decode(robotsRes.bytes) : null,
    "DailyBot",
  );
  console.log(
    `robots.txt ${target.host}: HTTP ${robotsRes?.res.status ?? "network error"}, crawl-delay ${robots.crawlDelaySec ?? "none"}`,
  );
  if (!robots.allowed(target.pathname + target.search)) return null;
  const wait = (nextAt.get(target.host) ?? 0) - Date.now();
  if (wait > 0) {
    console.log(`waiting ${Math.ceil(wait / 1000)} s (crawl-delay)`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  nextAt.set(target.host, Date.now() + (robots.crawlDelaySec ?? 0) * 1000);
  return fetchLimited(
    url,
    { headers: { Accept: ACCEPT }, signal: AbortSignal.timeout(30_000) },
    MAX_BYTES,
    fetch,
  );
}

async function convertPage(
  ai: Ai,
  step: string,
  url: string,
): Promise<Outcome> {
  console.log(`\n=== ${step}: ${url}`);
  try {
    const page = await politeFetch(url);
    if (!page) return { step, ok: false, detail: "robots.txt disallows" };
    const type = (page.res.headers.get("Content-Type") ?? "").toLowerCase();
    console.log(
      `HTTP ${page.res.status}, content-type ${type}, ${page.bytes.byteLength} bytes, truncated ${page.truncated}, user-agent ${USER_AGENT}`,
    );
    let markdown: string | null;
    let rung: number;
    if (type.startsWith("text/markdown")) {
      markdown = new TextDecoder().decode(page.bytes);
      rung = 1;
    } else {
      const mime: MarkdownMime = type.startsWith("application/pdf")
        ? "application/pdf"
        : "text/html";
      markdown = await toMarkdown(ai, page.bytes, mime, url);
      rung = 2;
    }
    if (markdown === null) {
      return { step, ok: false, detail: "toMarkdown returned an error" };
    }
    console.log(
      `rung ${rung}, ${markdown.length} characters, cost 0 (free conversion)`,
    );
    console.log(`first ${PREVIEW} characters:\n${markdown.slice(0, PREVIEW)}`);
    return { step, ok: true, detail: `rung ${rung}, ${markdown.length} chars` };
  } catch (error) {
    const detail = describeError(error);
    console.log(`FAIL: ${detail}`);
    return { step, ok: false, detail };
  }
}

async function readJina(url: string): Promise<Outcome> {
  const step = "jina";
  const { model } = DEFAULT_SLOTS.read;
  console.log(`\n=== ${step}: ${model} ${url}`);
  try {
    const raw = (await jinaTransport({ apiKey: jinaKey }).run(model, {
      url,
    })) as JinaRaw;
    console.log(
      `x-usage-tokens ${raw.usageTokens ?? "missing"}, ${raw.text.length} characters, truncated ${raw.truncated}`,
    );
    console.log(
      `raw head (first ${PREVIEW} characters):\n${raw.text.slice(0, PREVIEW)}`,
    );
    const markdown = parseJinaText(raw.text);
    if (markdown === null) {
      return { step, ok: false, detail: "Jina reports a target error" };
    }
    const price = DEFAULT_PRICES[model];
    const micros =
      raw.usageTokens === null ? null : costMicros(price, 0, raw.usageTokens);
    console.log(
      `rung 3, ${markdown.length} characters after "Markdown Content:", cost ${micros ?? "?"} micro-USD`,
    );
    return {
      step,
      ok: true,
      detail: `${markdown.length} chars, ${micros ?? "?"} micro-USD`,
    };
  } catch (error) {
    const detail = describeError(error);
    console.log(`FAIL: ${detail}`);
    return { step, ok: false, detail };
  }
}

console.log(`binding auth: ${bindingAuth}, config ${CONFIG_PATH}`);
const outcomes: Outcome[] = [];
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ AI: Ai }>>> | null =
  null;
try {
  proxy = await getPlatformProxy<{ AI: Ai }>({
    configPath: CONFIG_PATH,
    persist: false,
  });
} catch (error) {
  const detail = `getPlatformProxy: ${describeError(error)}`;
  console.log(`FAIL: ${detail}`);
  outcomes.push(
    { step: "html", ok: false, detail },
    { step: "pdf", ok: false, detail },
  );
}
if (proxy) {
  try {
    outcomes.push(await convertPage(proxy.env.AI, "html", HTML_URL));
    outcomes.push(await convertPage(proxy.env.AI, "pdf", PDF_URL));
  } finally {
    await proxy.dispose();
  }
}
outcomes.push(await readJina(HTML_URL));

console.log("\n=== summary");
for (const o of outcomes) {
  console.log(`${o.step.padEnd(5)}  ${o.ok ? "ok" : "fail"}  ${o.detail}`);
}
process.exit(outcomes.every((o) => o.ok) ? 0 : 1);
