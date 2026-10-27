# Daily architecture contract

Every issue is implemented against this file. To change a rule here, open a separate PR and update the affected issues.

Sources of requirements, in order of priority:

1. `docs/plan/Newsren_Plan.md`: product requirements that must be met. Below, `N§x` refers to its sections.
2. `docs/design/decisions.md`: scope decisions and technical decisions confirmed by the owner.
3. `docs/design/core-design.html`: core design v0.2. AIHOT is a reference only.

Labels: **verified** = the official documentation text was read; **assumed** = plausible but not checked. The issue that depends on it checks it during implementation.

## 1. Runtime

One Worker: `ainews-app`. Account simon (`5ad69dedffa38d8b7ab8ab17e051e410`), domain `news.ioenv.com`, `workers_dev = false`.

```
src/server.ts            custom entry: export default { fetch, scheduled, queue }
  fetch     → TanStack Start handler (public site + /admin)
  scheduled → scheduling only: pick the due work and send it to the queues
  queue     → consumers of pipeline/
```

TanStack Start uses `@cloudflare/vite-plugin`. The custom entry can export the Queues handler and the Cron handler together. Bindings are read with `import { env } from "cloudflare:workers"` (**verified**, the TanStack Start guide for Workers).

### Bindings

| Name | Type | Purpose |
|---|---|---|
| `DB` | D1 `ainews` | All business data, accessed with Drizzle |
| `BODIES` | R2 `ainews-bodies` | Article bodies, stored by version, never overwritten; the raw input under `feed/` is the exception |
| `Q_INGEST` | Queue, `max_concurrency = 2` | Collect → body → analyze. Can run in parallel (limit 2, guards against bursts, #53) |
| `Q_GROUP` | Queue, `max_concurrency = 1` | Grouping. A batch is processed in order |
| `Q_GENERATE` | Queue | Event artifacts, reports, watch, Ask, discovery |
| `Q_DLQ` | Queue | Dead-letter queue shared by the three queues above. Its consumer stores the messages in the `dlq_messages` table. The admin console views and replays them from the table (a Worker cannot list the messages in a queue directly) |
| `V_EVENTS` | Vectorize, 1024 dimensions | Event recall, metadata `industry_id` |
| `V_CHUNKS` | Vectorize, 1024 dimensions | Body chunks, used by Ask and by claim evidence |
| `AI` | Workers AI | Jev, embeddings, `toMarkdown()` |
| `EMAIL` | Email Service `send_email` | Sends to the admin only |

### Variables and secrets

- Variables: `SITE_URL`, `ADMIN_EMAIL`, `EMAIL_FROM` (default `digest@ioenv.com`, **assumed**, awaiting owner confirmation), `ACCESS_TEAM_DOMAIN` (full origin, such as `https://<team>.cloudflareaccess.com`), `ACCESS_AUD`, `AI_GATEWAY_ID`, `SEC_USER_AGENT`, `CF_BEACON_TOKEN` (Web Analytics; an empty string = do not output the beacon script).
- Secrets (stored locally in `.env.prod`, never in git; online, set them with `wrangler secret`): `JINA_API_KEY`. Upload `CF_AI_API_TOKEN` only if the smoke test in #3 proves that the runtime needs it. `CLOUDFLARE_API_TOKEN` is an Account API token (`ainews-deploy`). Local `provision.sh` and the CI deploy use it. The GitHub secret has the same name. `account_id` is written in `wrangler.jsonc`, so CI does not need `CLOUDFLARE_ACCOUNT_ID`; only local scripts use it. `IP_HASH_SALT` (#132): the salt that public write entry points use to hash network addresses. It has at least 32 random bytes and is shared by all public write entry points. Set it only with `wrangler secret`, never in `vars`. If it is missing or empty, the write entry points that need it refuse to write.
- Safety switches. A switch is on only when its value is `"true"`. All are off by default: `COLLECT_ENABLED`, `MODEL_CALLS_ENABLED`, `EMAIL_ENABLED`, `THIRD_PARTY_READER_ENABLED`, `DISCOVERY_ENABLED`, `READER_WATCH_ENABLED` (#132, reader-created watches, see §6 "Reader watch"), `ASK_PUBLIC_ENABLED` (#133, reader Ask on the event page). `ASK_PUBLIC_ENABLED`: only `"true"` turns it on. At the top level and in `env.test` it is `"false"`. When it is `"false"`, the event page has no entry point and `askAboutStory` returns 403 `ask_disabled`. v1 does not include Finance (403 `section_not_allowed`, the entry point is not shown).
- In tests, the safety switches stay off. External requests go only to local fake services.

## 2. Frontend contract (owner's original text)

> Build a TanStack Start application with file-based TanStack Router routes, validated search params, route loaders, typed server functions, full-document SSR, and streaming. Keep server-only work behind explicit boundaries, choose the appropriate SSR mode per route, and target the deployment runtime without changing the application model.

Applied to this project:

| Route | SSR mode | Data |
|---|---|---|
| `/`, `/s/$section`, `/e/$eventId`, `/digest/$section/$date`, `/w/$watch` | Full SSR, secondary blocks streamed | The loader calls a server function of `publication/` |
| `/a/$articleId` | Full SSR | The loader calls a server function of `publication/` (D1 + R2 `BODIES`, no model call, no budget use) |
| `/rss/*.xml` | server route, plain text | `publication/`. In a section feed, the `<link>` of an item is `{SITE_URL}/a/{id}`, the description carries the original link, and the guid does not change |
| `/follow` | Full SSR | The form for readers to create a watch and the form to revoke one. The switch state comes from `loadSiteShell`. Writes go only through the POST server functions of `server/reader-watch/`. 404 when `READER_WATCH_ENABLED` is not `"true"` |
| `/rss/p/{token}.xml` | server route, plain text | The private RSS of a reader, served only through `server/reader-watch/`. See §6 "Reader watch" |
| `/admin/*` | `ssr: 'data-only'` | Server functions of `admin/`, which pass the Access middleware first |

Article reading page `/a/$articleId`:

- **Approved** is decided only by `approvedArticleWhere`. Do not write another condition. If the condition fails → 404. The body version shown is `articles.body_sha` of the row that passes this condition (this is the version that the review record is bound to). The R2 key is `bodies/{article_id}/{body_sha}.md`. Do not look for "the newest R2 object".
- The **display scope** is decided by `content_display` of the source (§9). Under no condition may the page show body text beyond that scope:
  - `full`: the full text. Use it only for sources in the public domain or sources that allow reprinting (government sources, arXiv). Commercial media use `excerpt`. The admin switches a source to `full` in the admin console only after confirming that the publisher allows reprinting.
  - `excerpt`: take complete top-level blocks from the start, in total at most 25% of the body and at most 300 words. If not even one block fits, show no body. Never cut in the middle of a paragraph. Count words by the text that the reader actually sees (including image alt text). After rendering, check once more against the visible text. If the limit is exceeded, show only the summary and the link to the original. After the body (or summary), add `Continue reading the original ↗`.
  - `summary`: show only the summary. Do not read R2.
  - When `articles.body_kind` is not `full` (R2 holds a feed summary), treat the article as having no body. Do not read R2.
  - If R2 has no object or the read fails: show the summary and the original link. The status code stays 200.
- The header and the footer both carry the original link `Read the original at {source} ↗`. On the article cards of the home page, the section page, and the event page, the title links to `/a/$id` and the card keeps the original link.
- `<link rel="canonical">` points to the original URL (not output when the URL is empty). `<title>` is `{article title} — {SITE_NAME}`. Text that readers can see is English only.
- A Finance article page shows the disclaimer. When there are corrections, it shows them (§7).
- **Rendering**: convert markdown to HTML on the server only, based on the existing markdown-it (the markdown sanitizer in `lib/`). Add no new dependency. markdown-it does not enter the client bundle. `components/**` and `routes/**` receive an HTML string.
- **Sanitizing is the only defense**: the CSP `script-src` contains `'unsafe-inline'` (`src/server/edge.ts`), so it cannot stop an injected inline script.
  - The output HTML may come only from markup that markdown-it generates itself, plus the horizontal scroll container around tables.
  - Never output raw HTML as is. Dangerous blocks such as `script`, `style`, `iframe`, and `form` are removed as a whole. Other tags are removed, and the text inside them is escaped and output as plain text.
  - Links allow only `http`/`https`. External links get `rel="nofollow noopener noreferrer"` (the same value as the existing rule).
  - Images allow only `https`, with `loading="lazy"` and `referrerpolicy="no-referrer"`. Other images keep only the alt text. Only `full` mode outputs images. `excerpt` mode outputs text blocks only; images keep only the alt text, and the alt text counts toward the 25% and the 300 words. Reason: excerpt mode does not reprint images of commercial media.
- **Typography**: the body width is about 68 characters. Headings, quotes, code, and tables all have styles. Tables and code blocks scroll horizontally in their own containers. Both the light theme and the dark theme apply. At 375px the page has no horizontal scroll.
- **Evidence anchors**: every quote in Inspect evidence carries a link. The original link stays as well.
  - The quote is inside the display scope of the reading page (the source is `full` and `body_kind='full'`): link to `/a/{id}#:~:text=…`, which highlights it on the site.
  - All other cases (every quote of an `excerpt` source, a `summary` source, no body): link to the original URL, also with `#:~:text=…`, and mark it beside the link with `Quote is in the full article at {source}`. For an `excerpt` source, the system does not yet decide whether a quote falls inside the excerpt. This way the page never shows body text beyond the copyright scope, and the event page does not need to read R2. After the evidence build stores a flag "is inside the excerpt", the link will change to an on-site highlight (W2 follow-up).
  - The text fragment is generated from the quote with the markdown marks removed.

The request path of a server function is `/_serverFn/*`. It is not under `/admin*`, which Access protects, and public pages use it as well, so the whole path cannot be handed to Access. Authentication of admin server functions: read the `Cf-Access-Jwt-Assertion` request header first. If it is missing, read the `CF_Authorization` cookie. Both go through the same full validation (#4). The Zero Trust application must turn off "Cookie Path Attribute". Otherwise the cookie is sent only under `/admin`.

- Search params are always validated with a schema (pagination, section, reader level `audience=student|educator|professional`).
- Code that runs only on the server lives in `src/server/**` and is exposed with `createServerFn`. `env` never appears in a component.

## 3. Directories and dependency rules

```
src/
  server.ts                 entry
  routes/                   file routes (public + admin)
  components/
  server/
    publication/            the only public read layer: all public pages and RSS read only from here
    admin/                  admin server functions + Access middleware
    reader-watch/           public write entry points: readers create and revoke watches; the read layer of the private RSS (#132). Writes are limited to the entry points in the "Public write entry points" table
    reader-ask/             public write entry points: reader questions on the event page and reading answers (#133). Writes are limited to the entry points in the "Public write entry points" table
    db/                     Drizzle schema, queries
  pipeline/                 collect · body · analyze · group · generate · digest · watch · ask · discover · edgar · funding
  providers/                model client, llm_calls ledger, budget, Jina, toMarkdown
  lib/                      pure functions: URL normalization, time zone, hash, markdown sanitizing
drizzle/migrations/         run by wrangler d1 migrations
tests/
```

The architecture test (`tests/architecture.test.ts`) enforces four rules:

1. `routes/**` and `server/publication/**` do not import `pipeline/**` or the model modules of `providers/**`. This guarantees that "a reader who opens a page does not trigger a model call".
2. `routes/**` reads data only through `server/publication/**`, `server/admin/**`, `server/reader-watch/**` (the read layer of the private RSS, #132), or `server/reader-ask/**` (#133). The writes of `server/reader-watch/**` and `server/reader-ask/**` are limited to the entry points in the "Public write entry points" table below.
3. `server/reader-watch/**` and `server/reader-ask/**` do not import `pipeline/**`, `providers/**`, or `server/admin/**` (type imports are not allowed either; the test aligns the queue message type with `AskMessage`). The R1 traversal of public entry points stops at these two directories (the same as `server/publication/`). `routes/**` may import these two directories.
4. Every `createServerFn(` in `server/reader-watch/**` and `server/reader-ask/**` is written as `createServerFn({ method: "POST" })`.

**Public write entry points** (new in #132): the entry points in the table below are the only ones through which the public site can write to the database. All other public code is read-only. To add an entry point, change this table first (the anonymous feedback of #24 and the reader Ask of #133 add rows by the same rule).

| Entry point | File + symbol | What it writes |
|---|---|---|
| Reader creates a watch | `src/server/reader-watch/api.ts` `createReaderWatch` | One `watches` row, `owner_kind = 'reader'` |
| Reader revokes a watch | `src/server/reader-watch/api.ts` `revokeReaderWatch` | `status`, `disabled_at`, `updated_at` of that row |
| Private RSS read | `src/routes/rss/p/{$token}[.]xml.ts` → `serveReaderFeed` | `last_read_at` of that row, at most once every 6 hours |
| Reader question | `src/server/reader-ask/api.ts` `askAboutStory` | One `questions` row, `origin = 'public'`, `scope_type = 'event'`, `public_token_hash` = sha256hex(token); then it sends `{ kind: "ask", questionId }` to `Q_GENERATE` |
| Reader reads the answer | `src/server/reader-ask/api.ts` `getStoryAnswer` | Writes nothing (POST only so that the token stays out of the URL). Only for a row with `origin = 'public'` and an equal token hash, it returns status, refusal, answer, verified citations, unverified |

Every write entry point meets the 6 rules below. Reader watch has two exceptions; the exceptions of reader Ask are at the end of this paragraph. First, rule 1 and rule 3 do not apply to "Private RSS read": it is a GET route (the token is in the path, and RSS readers send only GET, so it does not go through the Origin check). It writes only `last_read_at` of that row, at most once every 6 hours, and only for a reader row with `status = 'active'` and an empty `disabled_at`. `src/server/edge.ts` sets the response headers for all status codes under `/rss/p/` in the same way (`Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`). Second, rule 3 does not apply to "Reader revokes a watch": neither revoking nor private RSS reading is affected by `READER_WATCH_ENABLED` (§6 "Reader watch", "Switch"). Reader Ask (#133) has three more exceptions:

- Rule 3 (own switch) does not apply to "Reader reads the answer", the same as revoking.
- Rule 4 (salted IP hash, per-network limit): v1 exception. There is only the site-wide limit `READER_ASK_LIMITS.publicPerDay = 30` (one `INSERT … SELECT … WHERE count < 30` per UTC day). The per-network limit (3 per network per day) is added in #166. Until it is added, `ASK_PUBLIC_ENABLED` is `"true"` only during demos.
- Rule 5 (no model call): `askAboutStory` itself does not call a model. The Ask consumer calls it, with tier `CALL_TIERS.adminAsk` and channel `gateway`. A public question (`origin = 'public'`) skips step 9, the supplementary fetch. It uses only the bodies of the approved articles of this event, and each question makes at most one reason call.

1. A write uses a server function with `method: "POST"`, and the handler checks once more that the request method is `POST` (it does not rely on the framework to reject GET). The request passes the Origin check of `src/server/edge.ts` (in effect for methods other than GET, HEAD, and OPTIONS). After the Origin check, `handleFetch` checks the request body size of non-safe-method requests to `/_serverFn/*` before parsing (the path test is the same as the existing one in `handleFetch`: `normalizePath(pathname)` starts with `/_serverfn`). This limit applies to all server functions, not only the entry points of this table. The limit is `SERVER_FN_MAX_BODY_BYTES = 65536` (64 KB; a bounded input string in the admin console has at most 1000 characters, and the JSON of section and source configuration is far below 64 KB). `Content-Length` greater than the limit → 413. `Content-Length` that is not a valid non-negative integer → 400. When `Content-Length` is missing, it does not return 411. Instead it reads `request.body` and counts bytes. If the count exceeds the limit, it cancels the read and returns 413. If not, it passes the bytes it read to the handler as `new Request(request, { body: bytes })` (a browser or HTTP/2 request may not carry this header, and that must not make every admin write fail). Both rejections are written like `forbidden()`: a plain-text body, 413 is `payload_too_large`, 400 is `bad_content_length` (these two strings are defined by this contract), with the security headers and `no-store`, and the handler is not called. A GET to `/_serverFn/*` and a POST outside `/_serverFn/*` are not checked. The check must be in the edge: in `server-functions-handler.js` of `@tanstack/start-server-core`, `handleServerAction` first parses the request body (JSON with `await request.json()`, forms with `request.formData()`) and then calls `action(...)`. Function middleware and the handler both run inside `action`, so the Access middleware of the admin console also rejects only after parsing. The framework itself limits only the `payload` query parameter of GET (`MAX_PAYLOAD_SIZE = 1e6`) and does not limit the POST body. The private RSS is a GET. Its only write is `last_read_at`, which only extends the life of the token holder's own row.
2. Input is validated with a strict zod schema (`.strict()`). Unknown fields are rejected. Lengths and character sets are in §6 "Reader watch".
3. Controlled by its own switch. A switch accepts only `"true"`.
4. The network address comes only from the request header `cf-connecting-ip`. Do not read `X-Forwarded-For` or the request body. For IPv4 take the full address. For IPv6 take the first 64 bits. The database stores only `sha256hex(IP_HASH_SALT + ":" + purpose + ":" + UTC date + ":" + network address)` (pseudonymization: a person who holds the salt can recompute the same hash for a known address). The raw address is never written to the database, never written to logs by application code, and never returned to the client. If `IP_HASH_SALT` is missing or empty, refuse the write. Do not fall back to an unsalted hash.
5. Does not call a model.
6. When a limit is exceeded, return a clear error code at once. Do not queue.

## 4. Pipeline: deterministic steps and model steps

The owner requires: fixed processes use deterministic code; quick judgments use Jev; writing and reasoning use the general-purpose model.

| Step | Method | Model slot |
|---|---|---|
| Scheduling, due-work selection, re-queueing | Deterministic | — |
| Parse RSS/Atom, extract from list pages | Deterministic (selectors are written in the source configuration) | — |
| URL normalization, deduplication, time zone | Deterministic | — |
| robots.txt, fetch ladder tier selection | Deterministic | — |
| Pre-filter: relevant / not relevant | Jev `choice` | `judge` |
| Five-dimension scoring, content type, evidence label | Jev `score` / `choice` | `judge` |
| Weighting, threshold, publish mode | Deterministic | — |
| Summary, rewritten title | Writing model | `write` |
| Grouping: merge into which candidate event, or create a new one | Jev `choice` (candidates come from Vectorize) | `judge` + `embed` |
| Story Brief, three-level explanation, digest body, classroom material | Writing model | `write` |
| Claim extraction and evidence location | Reasoning model; the backend checks one by one that each quote is really in the body | `reason` |
| Ask, weekly report, industry impact, AI-drafted section configuration, financial report interpretation | Reasoning model | `reason` |
| Watch: is it substantive progress | Keyword and category rules filter first; Jev `noul` handles the rest | `judge` |
| Source discovery: relevance | Jev `score` | `judge` |
| Funding record deduplication, financial report numbers | Deterministic (company + round key; XBRL values) | — |

### Model slots (stored in the settings table, editable in the admin console)

| Slot | Default model id |
|---|---|
| `judge` | `typesafe/jev` |
| `embed` | `@cf/baai/bge-m3` |
| `write` | `google/gemini-3.8-flash` |
| `reason` | `google/gemini-3.8-flash` |

- All slots are called with `env.AI.run(model, input, { gateway: { id: AI_GATEWAY_ID } })`. The code examples on the model pages use `env.AI.run` for all of these models (**verified**, the `google/gemini-3.8-flash` page).
- The billing channel is stored per slot in settings. It was settled by measurement in #3: judge, write, and reason use the prepaid credits of AI Gateway (judge was confirmed by the user in the AI Gateway logs; write and reason follow the definition of Unified Billing, **inferred**). embed uses Workers AI billing (**inferred**: the `@cf/` prefix means a Workers AI own model; not confirmed in the logs). All four slots called successfully through the binding (**verified**, the smoke test of #3). Production uses the binding and does not need REST.
- Jev: a structured evaluation model. The input is `state` plus a group of `noul` / `choice` / `score` questions. The output is probabilities and confidence. Context is 32,000 tokens. Input costs $0.042 / 1M tokens, output is free (**verified**, the model catalog page). When the context is exceeded, truncate the body and send only the title, the summary, and the beginning.
- The model catalog also lists OpenAI models such as `gpt-5.5` (**verified**). To switch to an equivalent OpenAI model, change only the slot.
- Amounts are always stored as integer micro-dollars (1 USD = 1,000,000).

## 5. Queues and state

```
cron ─► Q_INGEST : collect(source) ─► body(article) ─► analyze(article)
                                                          │ selected
                                                          ▼
                    Q_GROUP (in order) : group(article) ─► event revision + 1
                                                          │
                                                          ▼
                    Q_GENERATE : artifacts · claims · watch · digest · ask · discover
```

- Each article records its stage in `articles.stage` (`collected → body_ready → analyzed → grouped`; an article that is not selected stops at `dropped`) and `stage_updated_at`. Any statement that writes `stage` also writes `stage_updated_at = now` and `requeue_count = 0`. A message carries only `kind` and an id. Exception: `artifacts` and `evidence` messages also carry the `revision` at enqueue time, see §6 "Debounce". The consumer dispatches by `kind`, reads the state from the database, and on a duplicate delivery skips the stages that are already done.
- Every 10 minutes the cron scans for stuck rows (a stage that has not changed for more than 30 minutes) and enqueues them again: `collected` and `body_ready` go back to `Q_INGEST`, `analyzed` goes to `Q_GROUP`. `dropped` and `grouped` are terminal states.
- #11 sends selected articles to `Q_GROUP`. The admin console views and replays the messages in the DLQ (see `Q_DLQ` in §1).
- Each consumer sets `max_batch_size` for the worst-case batch: one invocation shares a 15-minute wall-clock time limit and a CPU limit.

## 6. Idempotency, concurrency, and budget

- **Model call ledger** `llm_calls`: `logical_key` is unique. The status is `pending → in_flight → completed | failed | unknown`, with `lease_expires_at`. A row with an expired lease can be taken over with a conditional `UPDATE`. A call that was sent but whose result was not saved is marked `unknown`, and the admin console reconciles it by hand. The promise is "no duplicate start, and recoverable", not "paid exactly once".
- **Budget reservation**: before a call, reserve with one conditional statement: `UPDATE budgets SET reserved = reserved + ? WHERE day = ? AND channel = ? AND reserved + spent + ? + ?floor <= cap`. `?floor` is the floor of this tier (see the next item, "Five gateway tiers"). For channels other than `gateway` it is always 0. If the number of affected rows is 0, do not call. The spend limit of AI Gateway is eventually consistent and serves only as the outer safety net (**verified**: "Spend limits are eventually consistent").
- **Five gateway tiers** (new in #116): the daily quota of `gateway` is split into five tiers by the purpose of the call. The tier is attached to the model client (the required option `tier` of `createModelClient`). It is not attached to the slot, the request, or the logical key, so it does not change `request_json`, `promptVersion`, or existing keys.
  1 = pre-filter, scoring, summary, grouping (including the accounting of `body`); 2 = Story Brief and three-level explanation; 3 = claims and evidence, admin Ask; 4 = learning material, section editorial products, admin watch; 5 = digest lead (digest, weekly report), discover, and the judgment of reader watch (#132).
  - **Reserves**: tiers 1–4 each have a reserve `R1..R4` (integer micro-dollars, default `R1 = 500000, R2 = 400000, R3 = 200000, R4 = 100000`, written in `DEFAULT_TIER_RESERVES`; the `settings` key `budget.tier_reserves` is optional and overrides the default when present; no migration is written). The floor of tier N is `floor(N) = R1 + … + R(N−1)`. So the floor of tier 1 is 0, and the floor of tier 5 is `R1 + R2 + R3 + R4`.
  - **Admission**: a call of tier N passes only if the remaining quota after the call is still at least `floor(N)`, that is, the condition above `reserved + spent + est + floor(N) <= cap`. Earlier tiers can therefore always use up their own share first. This applies only to `gateway`. `workers_ai` (embed) and `jina` each have their own limit and have no tiers.
  - **Ledger**: `llm_calls.tier` (nullable integer, added by the #116 migration with ADD COLUMN; rows from before the migration are NULL, and the admin console shows "untiered"). The admin console page `/admin/ledger` sums the `gateway` spend of the day by `tier`.
  - **Rejected**: as now, the row is written back as `failed` with `error = 'budget_exceeded'`, `failures` does not change, and no money is spent. The work moves to later: the due scans of artifacts / evidence / watch enqueue it again, the `generate` consumer acks `BudgetExceededError` directly (no more retry into the DLQ), and the grouping consumer resets `requeue_count` on it and the article stays `analyzed` to wait for the next round.
  - **Known behavior**: when the digest lead (tier 5) is rejected, the digest of that day has no lead and shows only the approved titles and summaries. It is not filled in on the next day. Production has no `digest.timezone`, so the default is UTC, and the digest is generated at the start of the budget day (00:00 UTC), when tier 5 passes. After the time zone is changed to another one, the digest is generated in the middle of the budget day, and tier 5 may reject the lead.
- **Grouping**: `Q_GROUP` has concurrency 1. Inside a batch, process in order with `for…of`; do not use `Promise.all`. Candidate events = Vectorize recall ∪ events created in D1 within the last 30 minutes (the Vectorize index is asynchronous). `event_articles.article_id` is unique.
- **Budget channels**: `workers_ai`, `gateway`, `jina`. v1 has no separate `ask` budget channel (acceptance item 2 of #133 is recorded as a demo-period deviation): public Ask and admin Ask share the gateway limit, with tier `adminAsk`. The whole site asks at most 30 questions per day × `ASK_QUESTION_MAX_COST_MICROS`. A separate fail-closed `ask` channel is implemented in a later slice of #133.
- **Event revision**: when it increments by 1, the three ways to write it, and all write paths are in "Event revision" below. Artifact key = `(event_id, type, audience, input_revision, prompt_version, model)`. An artifact is written only when `input_revision` equals the current revision, so that an old task cannot overwrite a new result.
- **Multi-table updates** are committed once with D1 `batch()`.
- **Bodies** are stored as `bodies/{article_id}/{sha256}.md` and never overwritten. Claim evidence references a specific version. At collection time, the `content:encoded` that the feed carries is stored as is in `feed/{sha256hex(canonical_url)}.html` (written by #5, written before the insert into `articles`, overwritten on each fetch). It is the raw input of tier 0 of body fetching, not a body version. #6 computes the key from `canonical_url` and reads it, and uses it if present.

Aliases used below in this section: `a` = `articles`, `e` = `events`, `ea` = `event_articles`, `art` = `event_artifacts`, `c` = `claims`, `ce` = `claim_evidence`. In SQL, always write `IS` / `IS NOT` to compare values that may be NULL. Parameter names such as `?articleId` in the fragments are only illustrations. The implementation uses numbered parameters `?1`, `?2`, and so on. Symbols and columns marked "new in #113" do not exist yet. #113 implements them.

### Event revision

The **approved input** of an event = the set of five-tuples `(article_id, body_sha, reviews.analysis_id, title_override, summary_override)` of every approved article (`APPROVED_ARTICLE_SQL`) in the event. When the approved input changes, `events.revision + 1` and write `updated_at = now`. Claim review (approve or reject) never increments. There are only three ways to write it:

| Way | When to use | SET |
|---|---|---|
| **Grow** | Only approved articles were added | `revision = revision + 1, updated_at = ?n, ${pendingSinceSetSql(n)}` |
| **Change** | An approved article was removed, or the analysis row, body, or override of an approved article changed | `revision = revision + 1, withdrawn_through = revision, updated_at = ?n, ${pendingSinceSetSql(n)}` |
| **Withdraw only** | The input has not changed yet, but the old version must go offline at once (re-analysis reset) | `withdrawn_through = revision`. No increment, no `updated_at`, no `<kind>_pending_since` |

- Each way is placed in the same `batch()` as the write that triggers it, and is chained with `changes() = 1` or `EXISTS(…)`: if the triggering write did not take effect, there is no increment.
- `events.withdrawn_through` (new in #113, `integer NOT NULL DEFAULT 0`) only grows, and `withdrawn_through <= revision`. All three ways keep both rules: grow does not touch it; change writes it as the old `revision`; withdraw only writes it as the current `revision`. In SQLite, the right side of `UPDATE … SET revision = revision + 1, withdrawn_through = revision` reads the old value (**inferred**, #113 proves it with a test).
- Functions: #113 adds `growRevisionStatement`, `changeRevisionStatement`, and `withdrawStatement` in `src/server/db/events.ts`. They have the same signature as `revisionBumpStatement` and replace it. `conditionalReviewRevisionBumpStatement` stays and gets a parameter `analysisId: number | null`. It extends its condition according to rows 1–4 of the table below.
- `pendingSinceSetSql(n: number): string` (new in #113, `src/server/db/events.ts`) returns the shared SET fragment: `artifacts_pending_since = COALESCE(artifacts_pending_since, ?n), evidence_pending_since = COALESCE(evidence_pending_since, ?n)`. `n` is the number of the parameter that binds `now` in the caller's statement (the `?n` in the table above is the same parameter). The fragment adds no parameter, and the parameter order of the caller does not change. Every statement that increments interpolates it: the existing increments (2 places in `src/server/db/events.ts`, 2 places in `src/pipeline/group/group-article.ts`, 3 places in `src/pipeline/evidence/primary.ts`; the 1 place in `reanalyzeArticle` changes to withdraw only per row 7), the new increments in the table below, the statement shared by rows 9/10 below, and the change in the "Reader-visible analysis row" migration. Do not write an inline copy.
- `revision = revision + 1` must not appear outside the table below. #113 adds a scan test that pins, per file, the increment statements and the number of references to `pendingSinceSetSql(` (the same as `EXPECTED_USES` in `tests/approved-definition.node.test.ts`).
- Review writes in the admin console do not send generation messages. `artifacts` and `evidence` messages are sent only by `enqueueDueEvents` of the cron (see "Debounce").

Write paths (all 16):

| # | File + symbol | Trigger | Way | Condition |
|---|---|---|---|---|
| 1 | `decideReview` (`src/server/admin/ops.ts`) → `conditionalReviewRevisionBumpStatement` | Approve an article that is not approved | Grow | The increment, `UPDATE event_articles`, and the reviews upsert all three carry the candidate condition `${CANDIDATE_ANALYSIS_ID_SQL} IS ?analysisId AND a.body_sha = ?bodySha`. When it does not hold, all three affect 0 rows, the function returns 409, the revision does not change, and the old version is not withdrawn |
| 2 | Same | Approve an article that is already approved, and `${CANDIDATE_ANALYSIS_ID_SQL} IS NOT reviews.analysis_id` | Change | The only way in the admin console to approve a new analysis. The candidate condition is the same as row 1. The increment comes before the reviews upsert and compares the `analysis_id` from before the upsert |
| 3 | Same; `retractArticle` calls it | Reject an approved article | Change | Do not check the candidate; check only `a.body_sha = ?bodySha`: the object of a rejection is `(article_id, body_sha)`. A rejection writes `analysis_id = NULL` |
| 4 | Same | Reject an article that is not approved | No increment | Do not check the candidate |
| 5 | `updateArticleOverride` (`ops.ts`) | Change the title or summary | Change | Only when the article is approved and the value really changed: the article UPDATE adds `WHERE title_override IS NOT ?1 OR summary_override IS NOT ?2`, and the increment statement carries `changes() = 1 AND ${APPROVED_ARTICLE_SQL}` |
| 6 | `changeArticleIndustry` (`ops.ts`) | Change the section | No increment; 409 + guard | If the lookup outside the batch finds the article in an event, return 409 (kept). Every statement in the batch (change `industry_id`, delete the auto approval) adds `AND NOT EXISTS (SELECT 1 FROM event_articles WHERE article_id = ?articleId)`. If the statement that changes `industry_id` affects 0 rows, return 409. Delete the `revisionBumpStatement` in the Finance branch: when the guard holds, the article is not in any event |
| 7 | `reanalyzeArticle` (`ops.ts`) | Re-analysis reset | Withdraw only | Only when the article is approved: `changes() = 1 AND ${APPROVED_ARTICLE_SQL}`. The increment happens when the new analysis is approved (rows 2 and 10). If the new analysis never gets saved, item 3 of the review queue catches it ("Reader-visible analysis row") |
| 8 | `analyzeArticle` commit (`src/pipeline/analyze/analyze.ts`), `review` mode | A new analysis is saved | No increment | The new row is only a candidate and goes to the review queue |
| 9 | Same, `auto` mode (`effectivePublishMode(row) === "auto"`, only a prediction) | The article is already in an event, the current body has no approval record yet, and the new analysis is auto-approved | Grow | The auto approval becomes `INSERT … SELECT … FROM articles a JOIN industries i ON i.id = a.industry_id WHERE <existing conditions> AND i.publish_mode = 'auto' AND lower(trim(i.slug)) IS NOT 'finance' AND changes() = 1 ON CONFLICT (article_id, body_sha) DO UPDATE SET analysis_id = excluded.analysis_id WHERE reviews.decision = 'approved' AND reviews.analysis_id IS NOT excluded.analysis_id`, with `analysis_id` = the row just inserted in the same batch. The section is judged again in SQL at commit time: after the analysis starts, the admin may move an article that is not yet grouped to Finance or to a `review` section (`changeArticleIndustry` deletes only existing auto approvals, and there is none yet). The increment uses the shared statement below |
| 10 | Same, `auto` mode | The current body of the article is approved, and a new analysis is saved | Change | The same upsert goes to `DO UPDATE`, and `analysis_id` becomes the new row. An existing rejection is not overturned. The increment uses the shared statement below. Finance and `review` sections never reach here: the SQL section condition of row 9 at commit time decides, and `effectivePublishMode` is only a prediction |
| 11 | `groupArticle` (`src/pipeline/group/group-article.ts`) merge branch and create branch | An approved article enters an event | Grow | Unchanged: `changes() = 1` and `EXISTS(approved)` |
| 12 | `src/pipeline/evidence/primary.ts`, a primary document is attached to an event (2 places) | A primary document is attached to an event | Grow | Unchanged: CAS / `changes() = 1` |
| 13 | Same file, a newly created primary article is auto-approved and attached to an event | A primary article enters an event | Grow | Add `changes() = 1` (the previous statement is the `event_articles` INSERT). Today there is no condition at all |
| 14 | `ingestCompanyFilings` (`src/pipeline/edgar/ingest.ts`) | The EDGAR body changed | Change | Only when the old body or the new body has an approval record: when a body changes from h1 to h2 and back to h1, the old approval of h1 takes effect again, and that is also a change. The upsert moves into `batch()`, and `changeRevisionStatement` is placed before it, with the condition `(SELECT body_sha FROM articles WHERE canonical_url = ?3) IS NOT ?11` (`?3` = `canonical_url`, `?11` = new `body_sha`) and `EXISTS (SELECT 1 FROM reviews r JOIN articles a ON a.id = r.article_id WHERE a.canonical_url = ?3 AND r.body_sha IN (a.body_sha, ?11) AND r.decision = 'approved')` (`a.body_sha` is the old body before the batch runs). Implementation: #113 |
| 15 | Recompute of `financial_facts.superseded_by` in `decideReview` | Approve or reject an EDGAR amendment filing | Change | Make a change on the event that contains the article of the original filing. See "Known gaps" item 1. Implementation: W4 EDGAR follow-up |
| 16 | The `force` branch of `src/pipeline/body/body.ts` | The body is re-fetched later and `body_sha` changes | Change | The rule is the same as row 14 (the old body or the new body has an approval record). Today no caller passes `force: true`; #113 does not change it. There is no implementation issue, see "Known gaps" item 3 |

The increment statement shared by rows 9 and 10: one statement both decides and increments. It does not rely on `changes()` to tell insert from update (both give `changes()` 1).

```sql
UPDATE events
SET revision = revision + 1,
    withdrawn_through = CASE WHEN EXISTS (
      SELECT 1 FROM reviews r
      WHERE r.article_id = ?1 AND r.body_sha = ?2 AND r.decision = 'approved'
    ) THEN revision ELSE withdrawn_through END,
    updated_at = ?3, ${pendingSinceSetSql(3)}
WHERE id = (SELECT event_id FROM event_articles WHERE article_id = ?1)
  AND <the upsert will surely take effect>
```

Parameter order: `?1` = article id, `?2` = the `body_sha` used by the analysis, `?3` = `now`, `?4` = `analysis_generation`, `?5` = `prompt_version` of this run (`analysed`).

- `EXISTS` true = the current body already has an approval record = change (row 10). False = grow (row 9).
- Position: the first statement of the batch, before the stage CAS, added only when `approve` is true. The current batch is one chain: "stage CAS → `INSERT INTO analyses … WHERE changes() = 1` → reviews upsert `… AND changes() = 1`". If the increment is inserted in the middle, the `changes()` of the upsert would read the row count of the increment.
- `<the upsert will surely take effect>` is written as four conditions on the state before the batch runs. When all hold, the next three statements take effect in order along the chain (**inferred**, #113 proves it with tests):
  - `EXISTS (SELECT 1 FROM articles WHERE id = ?1 AND stage = 'body_ready' AND body_sha = ?2 AND analysis_generation = ?4)` (the same set of conditions as the stage CAS);
  - `NOT EXISTS (SELECT 1 FROM analyses WHERE article_id = ?1 AND prompt_version = ?5)`;
  - `NOT EXISTS (SELECT 1 FROM reviews WHERE article_id = ?1 AND body_sha = ?2 AND decision = 'rejected')`;
  - `EXISTS (SELECT 1 FROM articles a JOIN industries i ON i.id = a.industry_id WHERE a.id = ?1 AND i.publish_mode = 'auto' AND lower(trim(i.slug)) IS NOT 'finance')` (the section condition of the upsert in row 9). Without this one, when the section is no longer auto, the upsert does not take effect but the revision is still incremented.

Implementation: #113 (except rows 15 and 16). Write the test for the section condition of rows 9 and 10 first. Reproduce it in this order: "the analysis starts and reads the auto configuration → the admin moves the article that is not yet grouped to Finance → the analysis commits". After the commit there must be no approval record with `reviewer = 'auto'`.

### Published version

Event artifacts and claims are visible to readers only when both hold: the status is `published`, and `input_revision` falls in the window `(events.withdrawn_through, events.revision]`. When several rows of the same `(type, audience)` are visible, show only the row with the largest `input_revision`. Claims are shown as a whole group per revision: take the largest revision in the window that has publicly visible claims ("Claim guard") and show only the claims of that revision.

- When the approved input only grows (the "grow" way in "Event revision"), `withdrawn_through` does not change. The old version stays visible until the version of the new revision is approved.
- Rejecting or withdrawing an approved article, a manual override of an approved article, approving a new analysis row, a body change, and re-analysis all push `withdrawn_through` to the old revision or the current revision in the same `batch()`. The old version becomes invisible at once.
- Changing a section must withdraw the old version at once (round 6). This is met by "an article in an event cannot change its section": `changeArticleIndustry` returns 409, and every statement in the batch carries the `NOT EXISTS (event_articles)` guard. So an article whose section changed is not in any event, no published version needs to be withdrawn, and the requirement of round 6 is already met.
- `revision_diff` is timeline history. It is not limited by the window and is still shown by "that revision has approved articles".
- When the window is empty (`withdrawn_through = revision`), the event page shows only the approved articles. It shows no artifact and no claim.

`PUBLISHED_ARTIFACT_SQL` (new in #113, `src/server/publication/events.ts`, aliases `art`, `e`):

```sql
art.status = 'published'
AND art.type IS NOT 'revision_diff'
AND art.input_revision > e.withdrawn_through
AND art.input_revision <= e.revision
AND NOT EXISTS (
  SELECT 1 FROM event_artifacts n
  WHERE n.event_id = art.event_id AND n.type = art.type AND n.audience = art.audience
    AND n.status = 'published'
    AND n.input_revision > art.input_revision AND n.input_revision <= e.revision
)
```

The visible revision of claims (used by `getEventEvidence`). The alias in the subquery is also `c`. The inner one shadows the outer one, so the alias in `VERIFIED_CLAIM_SQL` need not change:

```sql
c.input_revision = (
  SELECT max(c.input_revision) FROM claims c
  WHERE c.event_id = e.id AND c.status = 'published'
    AND c.input_revision > e.withdrawn_through AND c.input_revision <= e.revision
    AND c.claim_text NOT LIKE '[%]'
    AND ${VERIFIED_CLAIM_SQL}
)
```

- The artifact query of `getEvent` (`src/server/publication/events.ts`): change the alias to `art` and replace the condition with `${PUBLISHED_ARTIFACT_SQL}`. `getEventEvidence` (`src/server/publication/evidence.ts`) switches to the visible revision condition above.
- The migration backfills `withdrawn_through = max(revision - 1, 0)`, so that after the deploy the window equals `{revision}`.
- `reviewArtifact` and `listPendingArtifacts` do not change: they review only the `pending_review` rows of the current revision.

Implementation: #113.

### Debounce

For `artifacts` and `evidence`, on top of the terminal-state check of #107, the due condition adds one more: `e.updated_at <= now - ARTIFACTS_DEBOUNCE_MS` **or** `e.<kind>_pending_since <= now - ARTIFACTS_MAX_WAIT_MS`.

- `ARTIFACTS_DEBOUNCE_MS = 30 * 60 * 1000` and `ARTIFACTS_MAX_WAIT_MS = 2 * 60 * 60 * 1000`. Both are exported from `src/pipeline/due-events.ts` (new in #113).
- These two values replace the wording of round 6, "only look at `updated_at` being at least 30 minutes ago" (`docs/design/decisions.md`, round 6, "Debounce"): if only quiet time counts, an event that someone keeps reviewing is never due. This change is recorded in the decisions of round 8.
- `events.artifacts_pending_since` and `events.evidence_pending_since` (new in #113, `integer`, nullable) = the time of the first increment after the last terminal marker of that kind was written. NULL = no increment since the last terminal marker of that kind was written. The second condition is the maximum wait: counted from the first increment that has not been generated yet, the event becomes due at least once within 2 hours.
- Debounce is only an extra condition of `DUE_KINDS.artifacts` and `DUE_KINDS.evidence`. The invariants of #107 do not change: due = the current revision has no terminal state (`doneSql`); order = `<kind>_scheduled_at ASC, id ASC`; no time-window selection is introduced. `watch` has no debounce.
- **A review session**: a series of revision increments on the same event, where two neighboring increments are less than 30 minutes apart. If the session increments N times, the cron starts to enqueue the event 30 minutes after the last increment, or 2 hours after the first increment of the session (whichever comes first), and generates the version of the revision at that time. Until the terminal marker of that kind is written, the same revision may be enqueued again in every cron round (see "Known behavior" below). The cron runs every 10 minutes (`wrangler.jsonc` `"crons": ["*/10 * * * *"]`), so the actual delay is 30–40 minutes.
- `artifacts` and `evidence` messages carry the `revision` at enqueue time (`ArtifactsMessage` and `EvidenceMessage` in `src/pipeline/messages.ts`). `generateEventArtifacts` and `generateEventEvidence` skip when the `e.revision` that they read in the input snapshot does not equal the `revision` of the message, or when the message has no `revision`. They write no terminal state (they do not call `markArtifactsEvaluated`, they write no `claims` row, including the terminal rows of `EVIDENCE_TERMINAL_SQL`), they do not call a model, and the next cron round decides again. On a skip, `<kind>_pending_since` is kept, and the next cron round enqueues again with the new revision. A retryable error (#107) that causes the same revision to be enqueued again does not count as a second trigger.
- Immediate sending is removed completely: the `artifacts` and `evidence` sends of `handleGroupBatch` (`src/pipeline/group/consumer.ts`), and `qArtifacts?.send` and `qEvidence?.send` in `src/pipeline/evidence/primary.ts`. The `watch` send of `handleGroupBatch` stays.

Writing and clearing:

| Column | Who writes |
|---|---|
| `events.updated_at` | Only a revision increment and `INSERT INTO events`. Withdraw only does not write it |
| `<kind>_pending_since` write | Only when the revision grows. Every increment writes `COALESCE(…, ?n)` through `pendingSinceSetSql(n)`, which records only the first increment after the terminal marker. The `INSERT INTO events` with `revision = 0` (the create branch of `groupArticle`) does not write it. An INSERT with `revision >= 1` equals one increment, and both columns get `now`. Withdraw only does not write it |
| `<kind>_pending_since` clear | Only when that kind writes its terminal marker, on the condition `revision = the revision of the marker`. artifacts: the UPDATE of `markArtifactsEvaluated` (`src/pipeline/artifacts/build.ts`) adds `artifacts_pending_since = CASE WHEN revision = ?2 THEN NULL ELSE artifacts_pending_since END` to its SET (`?2` = the revision of the marker), and the WHERE does not change. evidence: at the end of the same `batch()` that writes the `EVIDENCE_TERMINAL_SQL` terminal row, add `UPDATE events SET evidence_pending_since = NULL WHERE id = ?1 AND revision = ?2 AND EXISTS (SELECT 1 FROM claims WHERE event_id = ?1 AND input_revision = ?2 AND claim_text IN (${EVIDENCE_TERMINAL_SQL}))` (`?1` = event id, `?2` = the revision of the marker). If the revision has already grown when the marker is written, do not clear, so a new increment is not lost. `enqueueDueEvents` does not clear (this replaces the ruling of batch 3, "clear on enqueue"). `watch` does not add it |
| `<kind>_scheduled_at` | Only `enqueueDueEvents` |

Change to `enqueueDueEvents`: the value type of `DUE_KINDS` gets an optional field `debounce?: { quietMs: number; maxWaitMs: number; pendingColumn: string }`. `artifacts` and `evidence` set it, and `watch` does not. After `NOT (${doneSql})`, the WHERE adds `AND (?2 IS NULL OR e.updated_at <= ?4 - ?2 OR e.${pendingColumn} <= ?4 - ?3)` and binds `quietMs ?? null`, `maxWaitMs ?? null`, and `now`. `watch` binds NULL and does not interpolate `pendingColumn`, so its behavior does not change. SELECT becomes `e.id, e.revision`, and the message is written as `{ kind, eventId, revision }`.

Migration backfill and the count before deploy (#113 runs them and pastes the result into the #113 PR): once for each kind, with the full due condition of `enqueueDueEvents`. Evidence is written the same way.

```sql
UPDATE events AS e SET artifacts_pending_since = e.updated_at
WHERE e.revision > 0
  AND EXISTS (
    SELECT 1 FROM event_articles ea JOIN articles a ON a.id = ea.article_id
    WHERE ea.event_id = e.id AND ${APPROVED_ARTICLE_SQL}
  )
  AND NOT (${DUE_KINDS.artifacts.doneSql})
-- evidence: evidence_pending_since, DUE_KINDS.evidence.doneSql
-- count before deploy: SELECT count(*) FROM events e WHERE <same conditions as above>
```

- The premise of "a session of at most 2 hours triggers only once": every increment writes `updated_at` and `pendingSinceSetSql(n)`; `artifacts` and `evidence` messages are sent only by the cron; an old message does not generate a new revision; after `generateEventArtifacts` finishes it writes `artifacts_evaluated_revision = revision`, and the event is not due again until the next increment; `<kind>_pending_since` is cleared only when that kind writes its terminal marker; the generators are idempotent per `(event, revision, type)` (the second "Known behavior" below).
- Cost: the first artifacts of an `auto` section are delayed by 30–40 minutes (D3 accepted).
- **Known behavior**: after the last approved article of an event is rejected, the event is no longer due, but the `<kind>_pending_since` written by this change is not cleared. The next time the event becomes due again, the first increment keeps the old value through `COALESCE`, so the maximum wait holds at once, and this time the 30-minute debounce is skipped. Bound: each "not due → due again" transition triggers at most one early run, so at most one extra generation. No clearing mechanism is added.
- **Known behavior**: the same revision is enqueued repeatedly. After it becomes due and before the terminal marker is written, the cron sends this event again in every round (`enqueueDueEvents`, `src/pipeline/due-events.ts:50-84`, as it is today). The premise is that the generators are idempotent per `(event, revision, type)`: evidence already has `already_exists` (`src/pipeline/evidence/build.ts:243`); artifacts skip existing artifacts type by type (`src/pipeline/artifacts/build.ts:674-683`, the INSERT carries `ON CONFLICT … DO NOTHING`). #113 adds a test for the idempotency of artifacts: run the same `(event, revision)` twice, and the second run calls no model for types whose artifact exists and adds no artifact row.
- **Known behavior**: a review session longer than 2 hours may be enqueued more than once. After each terminal marker is written, the next increment in the session restarts the timer, and the event becomes due again after 2 hours. Bound: the maximum wait triggers at most once every 2 hours; after the session ends, one more trigger after 30 minutes of quiet.

Implementation: #113.

### Claim guard

A claim can be approved, made public, and used as input of an artifact only if it satisfies `VERIFIED_CLAIM_SQL`: at least one evidence row has `verified = 1` and `stance = 'support'`, the article that this evidence references is an approved article of the event, and the `body_sha` of the evidence equals the current `body_sha` of the article.

`VERIFIED_CLAIM_SQL` (new in #113, `src/server/publication/evidence.ts`, alias `c`):

```sql
EXISTS (
  SELECT 1 FROM claim_evidence ce
  JOIN articles a ON a.id = ce.article_id AND a.body_sha = ce.body_sha
  JOIN event_articles ea ON ea.article_id = a.id AND ea.event_id = c.event_id
  WHERE ce.claim_id = c.id AND ce.verified = 1 AND ce.stance = 'support'
    AND ${APPROVED_ARTICLE_SQL}
)
```

- `ce.stance = 'support'`: `evaluateClaimConsensus` (`src/pipeline/evidence/verify.ts`) counts only verified support as support, so the guard is consistent with the consensus rule.
- `verified` is written once, only by the `INSERT INTO claim_evidence` of `generateEventEvidence`: for each quote that the model gives, read R2 `bodies/{article_id}/{body_sha}.md` (`body_sha` is the current body of this approved article at generation time), look for the quote in the body with `verifyQuoteInBody`, and write 1 if found and 0 if not. It is never updated afterward. When the body changes version, the old evidence becomes invalid by itself (`a.body_sha = ce.body_sha`) and needs no rewrite.
- The guard is checked once at approval time and once at read time, and the result at read time decides: the article may be withdrawn or get a new body later.

| Reader / writer | Contract |
|---|---|
| `reviewClaim` (`ops.ts`) | The statement becomes `UPDATE claims AS c …`. On approval add `AND (?1 IS NOT 'published' OR ${VERIFIED_CLAIM_SQL})`. Rejection is not limited |
| `listPendingClaims` (`ops.ts`) | Returns the guard result of each claim. The admin console disables "Approve" for claims that do not satisfy it |
| Event-level one-click approve (new in #113) | Approves only the claims that satisfy the guard. The others stay `pending_review` |
| `getEventEvidence` | WHERE adds `AND ${VERIFIED_CLAIM_SQL}`. Today claims with zero evidence are also public |
| The retracted-claim query of `getEvent` | Changes to `NOT ${VERIFIED_CLAIM_SQL}`. Today claims with zero evidence do not count as withdrawn |
| `generateEventArtifacts` reads claims as artifact input | Add `AND ${VERIFIED_CLAIM_SQL}` |
| `src/pipeline/evidence/diff.ts` reads claims | Add `AND ${VERIFIED_CLAIM_SQL}` |
| Status of `INSERT INTO claims` in `generateEventEvidence` | Unchanged: with `auto` and a consensus that is not `unverified`, the claim is `published` directly, and then the guard already holds |

**Known behavior**: claim review does not change the revision. An artifact reads only the published claims with `input_revision` = the current revision (`generateEventArtifacts`, `src/pipeline/artifacts/build.ts:233-239`). So a claim approved after the artifacts of R were generated does not enter any artifact. At R+1 the evidence is extracted again, and the new claims must be reviewed again. A claim that was rejected stays `pending_review` until it is rejected, was never published, and never entered any artifact input (`reviewClaim` changes only claims with `status = 'pending_review'`).

Implementation: #113.

### Reader-visible analysis row

The reader-visible analysis row = the row written in the approval record of the current body of the article: `reviews.analysis_id` (new in #113, `integer`, nullable, no foreign key). Every page and generator that shows what readers see or will see uses `READER_ANALYSIS_ID_SQL`, and so does the claim review page: public pages, RSS, digests, artifacts, evidence, the non-review pages of the admin console, and the claim review page (`listPendingClaims`). If there is no approval record, or `analysis_id` is NULL, no analysis row is used, and the text falls back to the manual override, and then to the title and summary of the source itself.

The analysis row awaiting review = `CANDIDATE_ANALYSIS_ID_SQL`: the newest row, with `primary_tracker` rows ordered after Jev rows. Only the article review queue (`listPendingArticles`) and grouping use it.

Saving a new analysis does not change the reader text (except for `auto` sections, see row 10 of "Event revision"). When the admin approves, `decideReview` writes `analysis_id` as the row shown on the review page. Until then, readers keep seeing the old approved row.

Two fragments (new in #113, `src/server/publication/articles.ts`, alias `a`):

```sql
-- READER_ANALYSIS_ID_SQL
(SELECT r.analysis_id FROM reviews r
 WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved')

-- CANDIDATE_ANALYSIS_ID_SQL
(SELECT x.id FROM analyses x WHERE x.article_id = a.id
 ORDER BY (x.prompt_version = 'primary_tracker') ASC, x.created_at DESC, x.id DESC LIMIT 1)
```

`reviews (article_id, body_sha)` is unique, so the first fragment has at most one row. Usage: `LEFT JOIN analyses an ON an.id = ${READER_ANALYSIS_ID_SQL}`.

- Switch to `READER_ANALYSIS_ID_SQL`: `CARD_FROM` and the home page correction query (`src/server/publication/articles.ts`), `generateEventArtifacts`, `generateEventEvidence`, the 6 places in `src/pipeline/digest/build.ts`, `src/server/publication/digests.ts`, `getEventEvidence`, `listPendingClaims`.
- Switch to `CANDIDATE_ANALYSIS_ID_SQL`: `groupArticle` reading the article (grouping uses the newest analysis, because the article is usually not yet approved at that time); `listPendingArticles` shows the candidate and also shows the reader row for comparison.
- Outside this rule: the origin query of `groupArticle` (`prompt_version = 'primary_tracker'`); `getArticle` (the article detail in the admin console) lists all analysis rows and is a history view.

Writing `reviews.analysis_id`:

| Writer | Contract |
|---|---|
| `decideReview` | Add the parameter `analysisId: number \| null` (the candidate shown on the review page). Approve: the reviews upsert writes `analysis_id = ?analysisId`, the candidate condition is the same as row 1 of "Event revision", and when it does not hold the statement affects 0 rows and the function returns 409. Reject: check only `body_sha` and write `analysis_id = NULL` |
| `analyzeArticle` auto approval | `analysis_id` = the row just inserted in the same batch (`SELECT id FROM analyses WHERE article_id = ?1 AND prompt_version = ?analysed`). For the shape of the upsert see rows 9 and 10 of "Event revision" |
| `src/pipeline/evidence/primary.ts` auto approval | `analysis_id` = the `primary_tracker` row of that article. Insert the analysis row first, then the approval record |

Review queue condition (`listPendingArticles`), three items joined with OR:

```sql
-- 1 not reviewed:
(a.stage IN ('analyzed','grouped')
 AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.article_id = a.id AND r.body_sha = a.body_sha))
-- 2 new analysis awaiting approval (including a re-analysis judged as not selected):
OR (${APPROVED_ARTICLE_SQL} AND ${CANDIDATE_ANALYSIS_ID_SQL} IS NOT ${READER_ANALYSIS_ID_SQL})
-- 3 re-analysis stuck, event withdrawn:
OR (a.stage = 'body_ready' AND a.requeue_count >= 3 AND ${APPROVED_ARTICLE_SQL}
    AND EXISTS (SELECT 1 FROM event_articles ea JOIN events e ON e.id = ea.event_id
                WHERE ea.article_id = a.id AND e.withdrawn_through = e.revision))
```

- Item 2 does not limit the stage: when re-analysis judges the article as `dropped` (the new row has `selected = 0`), it also enters the queue and the article is not withdrawn automatically. Approve = adopt the new row (the reader text falls back to the manual override or the source summary); reject = take it offline.
- The "stuck" of item 3 has the same definition as `listStuckArticles`: `stage = 'body_ready' AND requeue_count >= 3` (3 = `MAX_REQUEUES`, `src/pipeline/requeue.ts`). The entry is marked "re-analysis stuck" and offers two actions: re-analyze (`reanalyzeArticle`, `expectedStage = 'body_ready'`) and reject (`decideReview` rejected). Approving on this item changes nothing: the candidate is still the old row, and row 2 of "Event revision" is not triggered (**inferred**).
- The reader text changes only under three kinds of writes, all of them changes: the `analysis_id` of the approval record changed (rows 2 and 10 of "Event revision"); a manual override (row 5); the one-time backfill below. The input of an artifact and what the reader sees are the same row, so an artifact is never generated from an analysis that is not approved.

Migration backfill: for every row `r` with `decision = 'approved'`, `analysis_id` = the choice of the review page at approval time (the current way of `listPendingArticles`: the newest row with `selected = 1`), restricted to before the approval time:

```sql
(SELECT x.id FROM analyses x
 WHERE x.article_id = r.article_id AND x.selected = 1 AND x.created_at <= r.created_at
 ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
```

- `r.created_at` is the time of the last decision: the upsert of `decideReview` overwrites it every time. The auto approval of `analyzeArticle` and the analysis row use the same `now`, and `<=` includes it.
- Risk (**inferred**): `analyses.created_at` is the time when the analysis starts, not the time when it is committed. An analysis that was running at approval time and committed after the approval is counted in. This comparison is used only for the one-time backfill. The runtime rule uses `reviews.analysis_id`.

Read-only counts before deploy (#113 runs them, pastes the result into the #113 PR, and shows it to the owner before merging):

- (a) The number of articles that have a newer candidate row: approved, and `${CANDIDATE_ANALYSIS_ID_SQL} IS NOT <backfill row>`. After the deploy these articles enter item 2 of the review queue. This is correct behavior.
- (b) The number of events that contain an article whose backfill row differs from the current reader row: articles that are approved and have `<backfill row> IS NOT (SELECT id FROM analyses WHERE article_id = a.id ORDER BY created_at DESC, id DESC LIMIT 1)` (the row that `CARD_FROM` selects today), counted by distinct events through `event_articles`.
- When (b) > 0, after the backfill the migration makes a change on these events (`revision = revision + 1, withdrawn_through = revision, updated_at = ?n, ${pendingSinceSetSql(n)}`, `?n` = the migration time). These events then regenerate artifacts and claims through the debounce, which costs model money. The dry-run count lists the event ids too. Merge #113 only after the owner confirms (merging means deploying, which means running the migration).

Implementation: #113.

### Known gaps

1. **After an amendment is approved, the original event is not incremented** (row 15 of "Event revision", EDGAR section of round 7): after an EDGAR amendment filing is approved or rejected, `financial_facts.superseded_by` changes, but the event that contains the original filing is not incremented. Implementation: W4 EDGAR follow-up.
2. **Cross-event dependency**: the year-over-year number of event E2 comes from a filing of event E1. If an article of E1 is rejected later, E1 is incremented, E2 is not, and the artifacts of E2 are not withdrawn. Implementation: W4 EDGAR follow-up.
3. **A later body re-fetch does not increment** (row 16 of "Event revision"): when the `force` branch of `src/pipeline/body/body.ts` changes `body_sha`, it does not increment. Today no caller passes `force: true`, so there is no actual exposure. There is no implementation issue. The PR that adds a caller implements it as in row 14.

### Reader watch (new in #132)

A reader does not register. The reader writes a question, a hit condition, and keywords, and gets a private RSS address (N§2.1, N§2.6, N§7 "Follow a Topic"). Implementation: #132.

**Data**: reader watches and admin watches live in the same `watches` table. They share the existing rules 1–3 of `evaluateEventWatches` (`src/pipeline/watch/evaluate.ts`) (1 section scope; 2 look only at articles that this watch has not cited and that were approved after the watch was created; 3 hit at least one keyword) and `watch_hits`. All new columns use `ALTER TABLE ADD COLUMN` with no CHECK:

| Column | Type | Meaning |
|---|---|---|
| `owner_kind` | text, not null, default `'admin'` | `admin` or `reader`; the closed set is validated on write |
| `token_hash` | text, nullable, unique index | SHA-256 (lowercase hex) of the token of a reader watch; NULL for an admin watch |
| `creator_hash` | text, nullable, indexed | Salted hash of the creator's network address (§3 "Public write entry points" rule 4, purpose `reader_watch`) |
| `last_read_at` | integer, nullable | The time of the latest read of the private RSS |
| `disabled_at` | integer, nullable | The time of disabling. Disabled = `status = 'paused'` and `disabled_at` not empty. It cannot be undone |

- The `slug` of a reader watch = `r-` plus 16 random lowercase hex characters. It is unrelated to the token and only satisfies the rule that `slug` is not null and unique. No public path uses it.
- **There is only one decision for a public watch**: `adminWatchWhere` (`src/server/publication/watches.ts`, `watches.owner_kind = 'admin'`). Every public query that reads `watches` carries it (watch page, `/w/` list, home page, header, public watch RSS). Public queries do not give `watches` an alias. A scan test pins that every `watches` read in `src/server/publication/**` and `src/routes/**` references it.
- The hits of a reader watch have `status = 'delivered'`: they do not enter the admin review queue, and they do not satisfy the `status = 'published'` of public reads.
- Watch editing in the admin console handles only `owner_kind = 'admin'`. Reader watches are listed separately in the admin console. They can only be disabled, not edited or restored. The admin console does not show `token_hash` or `creator_hash`.

**Token**:

- When it is created, take 32 bytes (256 bits) with `crypto.getRandomValues` and encode them as base64url without padding, 43 characters.
- The database stores only `token_hash = sha256hex(token)`. The plain text is returned only once, in the response of creation. It is not written to the database and does not enter `llm_calls`. Application code does not write the token or the full private RSS address to logs.
- Logs: the token is in the URL path, and the invocation logs of Cloudflare record the request URL, so the token may appear there. Only the account owner can read these logs. The account owner can already read all watches in D1, so nobody gets extra access from this.
- Private RSS address: `{SITE_URL}/rss/p/{token}.xml`. If the token does not match `^[A-Za-z0-9_-]{43}$`, or the lookup by `token_hash` and `owner_kind = 'reader'` finds nothing: 404. Disabled: 410.
- Not enumerable: the token space is 2^256; no public interface lists reader watches; `slug` is unrelated to the token, and visiting `/w/$slug` with a `slug` is blocked by `adminWatchWhere` (404).
- Revoke: `revokeReaderWatch({ token })` (POST) writes the row as disabled. A revoke does not give back the creation quota.
- Response headers of the private RSS: `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`. The private RSS does not appear in public pages, public RSS, or the loader data of pages.

**Input**: the request body size is checked before parsing only by the global limit of rule 1 in §3 "Public write entry points" (`SERVER_FN_MAX_BODY_BYTES = 65536` in `src/server/edge.ts`, in effect for non-safe-method requests to all `/_serverFn/*`). The reader write entry points have no separate request body limit. After parsing and before normalizing, first check the raw length of each string: `question` at most 400 characters, `criteria` at most 600, each keyword at most 80. When a limit is exceeded, return 413 `payload_too_large` and do not write to the database. These raw length limits apply only to reader write entry points. The admin console and other server functions are not affected. Then do NFC normalization, trim the leading and trailing white space, merge consecutive white space into one space, and validate with zod `.strict()`.

| Field | Rule |
|---|---|
| `question` | 10–200 characters |
| `criteria` | 10–300 characters |
| `keywords` | 1–5 items, each 2–40 characters, deduplicated case-insensitively |
| `industrySlug` | May be null (= all sections except Finance); when not null it must be an existing section and not Finance |

- The three text fields share the character allowlist `/^[\p{L}\p{M}\p{N} .,;:!?'()\-–—\/&%$#+@*]+$/u`. Double quotes, backticks, `< > { } [ ] = \ | ^ ~ _`, control characters, zero-width characters, and bidirectional control characters are not in the allowlist and are rejected in validation. Line breaks and other white space are merged into one space during normalization, so the text that reaches the prompt has no line break.
- The allowlist constrains only the format. The judge prompt `buildWatchJudgeQuestion` puts the question and the criteria in double quotes (`Topic Question: "…"`). This text does not change. The reader's text has no double quote and no line break, but this does not stop a question from trying to steer the judgment result. Money and publication safety do not depend on the model following the rules. They depend only on deterministic defenses: the daily limit of judgment attempts, the tier-5 budget admission, and the private RSS that outputs only approved articles and contains no model-written text (see "Hit"). The question set of the offline evaluation must include injection-style questions (see "Switch").
- Keywords are required: rule 3 does not call a model for a watch without keywords. Keywords are matched by `matchKeyword` (a pure ASCII word by word boundary, anything else by substring). A common word such as `AI` makes one watch match most events. The safety net is the daily limit of judgment attempts and the tier-5 budget admission. Keywords are not extracted from the question automatically: extracting them with a model would spend money on an anonymous entry point, and splitting by words would make the keyword filter useless.
- What is stored and where it goes: the question, the criteria, and the keywords are stored in plain text in `watches`. The question and the criteria are also stored in plain text in `llm_calls.request_json` (the judgment request) and sent to the model provider. After a watch is disabled, this text is still kept. Deleting disabled reader rows and cleaning the reader text in `llm_calls.request_json` is a separate later issue (a non-goal of #132). The `/follow` page states this in one line.

**Limits** (the constant `READER_WATCH_LIMITS`, `src/server/reader-watch/limits.ts`, open a separate PR to change a value):

| Limit | Value | When exceeded |
|---|---|---|
| Creations per network address per UTC day (including revoked and disabled rows) | 3 | 429 `per_network_limit` |
| Active reader watches on the whole site (`owner_kind = 'reader' AND status = 'active'`) | 200 | 503 `capacity_full` |
| Judgment attempts of reader watches per UTC day (each admission counts once, see "Judgment") | 500 | Skip the remaining reader watches of the current event; admin watches are evaluated as usual; the event is not marked and continues the next day (see "Judgment") |

- The hash contains the UTC date, so the daily creation count is counted directly by `creator_hash`. This hash is pseudonymized, not anonymized: hashes of different dates differ, but a person who holds `IP_HASH_SALT` can recompute the hash of any day for a known address.
- Creation is one `INSERT INTO watches … SELECT … WHERE (number of rows with the same creator_hash) < 3 AND (number of active reader watches on the whole site) < 200`. When it affects 0 rows, read the two counts again to decide between 429 and 503.
- Creation does not call a model and does not spend money.

**Judgment**: on top of the existing rules, `evaluateEventWatches` adds only the items below. Rules 1–3, deduplication, and the revision marker do not change.

- When `READER_WATCH_ENABLED` is not `"true"`, reader watches do not take part in evaluation (they are excluded in SQL), and the event is marked as usual. Reader watches do not make up later for progress that appeared while the switch was off.
- Reader watches do not evaluate events of the Finance section (N§4 "no personalized investment advice"; the reader Ask v1 of round 6 does not include Finance).
- Judgment uses the same `buildWatchJudgeQuestion`, the same `WATCH_PROMPT_VERSION`, and the same way of writing the logical key. Tier: a reader watch is tier 5 (`CALL_TIERS.readerWatch`), and an admin watch is still tier 4 (`CALL_TIERS.watch`). The tier is attached to the model client, so `evaluateEventWatches` creates a separate tier-5 model client for reader watches.
- Daily limit of judgment attempts: it counts admissions, not keys and not real sends. When the ledger has no `completed` row, one admission is registered on the day of the call (UTC) before each call to `judge`: a first attempt, a retry, and a call again for a key that was already admitted on the previous day each count once. A call that is admitted and then not really sent also counts once: rejected by the budget, `CallInProgressError` (the same key is being sent in another consumer), retries used up. When the same event is delivered twice, or two consumers judge the same key at the same time, both register. All of these only make the limit trigger earlier. They never spend extra money. Only a ledger cache hit does not count: before a reader watch calls `judge`, it first checks whether the ledger `llm_calls` has a `completed` row for this logical key (`findCompleted`, `src/providers/ledger.ts`). If it has one, the call goes directly (the model client returns the stored result, sends nothing, and registers nothing). If not, one attempt is registered in `reader_watch_admissions`: `INSERT INTO reader_watch_admissions (logical_key, day, created_at) SELECT ?1, ?2, ?3 WHERE (SELECT count(*) FROM reader_watch_admissions WHERE day = ?2) < ?4`. 1 row affected: pass. 0 rows affected, or the `judge` of the reader watch throws an error other than `CallFailedError` (for example the tier-5 budget rejection `BudgetExceededError`): postpone the reader watches of this event, that is, skip this reader watch, and the remaining reader watches of this event are skipped directly too (no more registration). Admin watches are evaluated as usual, nothing is thrown, and the evaluation of the event runs to the end. A `CallFailedError` of a reader watch skips only that one watch and does not postpone. Errors of admin watches are thrown as before. When the evaluation ends, this event is not marked (`watch_evaluated_revision` is not written), and the due scan of the cron enqueues it again later. On the rerun, the watches that were already judged use the stored result in the ledger and do not cost money again. So there is no need to require that admin watches be evaluated first. `day` = `utcDay(now)`. Registration comes before budget admission, so an attempt rejected by the budget also counts once.
- **Known behavior**: when the event enters a new revision during the postponement, the postponed reader watch next time treats only the reports of the newest revision as new reports, and puts the earlier reports into "old reports". This happens only when the daily limit of judgment attempts is reached or tier 5 is rejected. It costs no extra money. No make-up judgment mechanism is added.
- The due scan (#92 `enqueueDueEvents`) rotates by `watch_scheduled_at` from oldest to newest, at most 20 events per round, so an event that stopped at the limit does not crowd out other events. Hits that were already written are not affected.
- The sentence in the original issue, "after the limit is exceeded a new creation request returns a clear error and is not queued", refers to the creation request: the per-address limit and the site-wide limit both return an error code at once. The daily judgment limit does not apply to creation requests. It postpones the background judgment, not a reader's request.
- **Hit**: a hit of a reader watch does not call `write`, `summary` is written as an empty string, and `status` is written as `delivered`. The private RSS shows only the own title and summary of the articles that the hit cites (`rationale.articleIds`) and that still satisfy `approvedArticleWhere`, the same as the digest items in round 6. The item title is the own title of the newest cited article that is still visible. When the title is empty, use the fixed text `Watch update`. The event title is not used (`events.title` comes from the article that created the event, which may not be cited or approved). A hit with no cited article that is still visible is not output. If the reader row is not `active`, or `disabled_at` is not empty, the private RSS returns 410. If `rationale` is not valid JSON, has no `articleIds`, or `articleIds` is not an array or is an empty array, the private RSS does not output this hit. Reasons: round 6 says "generated content must still be approved by a person before it reaches readers", and this is not relaxed; sending hits to admin review would make the review load grow with the number of anonymous readers; and write costs 3,083 µ$ on average per call, so 500 hits cost $1.54 per day in the worst case, which exceeds the window of tier 5.
- No new write or reason call site is added, so no new finishReason probe is needed.

**Cleanup**: `sweepReaderWatches` (`src/pipeline/watch/reader.ts`) is called once by `runScheduled` in every cron round. It does not look at the switch (it only disables and only deletes).

- Disable: `owner_kind = 'reader' AND status = 'active'`, and any of the following holds; write `status = 'paused', disabled_at = now, updated_at = now`:
  - `last_read_at IS NULL AND created_at <= now − 3 days` (nobody subscribed after creation);
  - `last_read_at <= now − 30 days`.
- Delete the rows of `reader_watch_admissions` whose `day` is earlier than `utcDay(now − 7 days)`.
- How `last_read_at` is written: each read of the private RSS runs `UPDATE watches SET last_read_at = ?2 WHERE id = ?1 AND (last_read_at IS NULL OR last_read_at <= ?2 − 21600000)`, so each watch is written at most once every 6 hours.

**Money** (**inferred**, based on the read-only production query of 2026-10-26):

- Production has no watch call yet (**verified**: `watches` has 0 rows, and `llm_calls` has no key that starts with `watch:`). Proxy value: all `completed` rows of the `judge` slot, 1,128 rows, average 133.8 µ$, maximum 337 µ$, average input 3,174 tokens (Jev input $0.042 / 1M tokens, output free). The input of a watch judgment is bounded (new reports ≤ 2,000 characters, old reports ≤ 2,000, summary ≤ 1,000, question ≤ 200, criteria ≤ 300). It is smaller than the judgment of analyze, so 134 µ$ is on the high side.
- With 500 judgment attempts per day: on average 500 × 134 = 67,000 µ$ ($0.067). Estimated with the largest sample so far, the worst case is 500 × 337 = 168,500 µ$ ($0.169). These two numbers are estimates, not limits. The hard limits are the daily limit of judgment attempts and the tier-5 budget admission. Creation, revoking, and RSS reads cost no model money.
- Tier 5 passes only when `reserved + spent + estimate + floor(5) <= cap`. `floor(5)` = the sum of the reserves of tiers 1–4 = 500,000 + 400,000 + 200,000 + 100,000 = 1,200,000, and `cap = 1,900,000`. So reader judgment can spend money only when the gateway quota used on that day is below 700,000 µ$ ($0.70). This window is shared with the digest lead and discover. By the estimates above, reader judgment takes 9.6% of the window on average and 24% in the worst case.
- Admin watches are in tier 4, with floor `floor(4)` = 1,100,000: `floor(5) − floor(4) = R4` = 100,000 µ$ ($0.10). When the quota used on that day is between $0.70 and $0.80, reader judgment is rejected and admin watches still pass. This holds per tier and also across events, so there is no need to require that admin watches be evaluated first within an event. Reader judgment cannot spend the reserves of tiers 1–4.
- The digest lead is also in tier 5, but the digest is generated at the start of the budget day (00:00 UTC) (the "Known behavior" of "Five gateway tiers" in this section). At that time the used quota is close to 0, and both the lead and reader judgment pass. After `digest.timezone` is changed, the digest is generated in the middle of the budget day, and the tier-5 quota that reader judgment has already used makes the lead easier to reject.
- When the gateway quota used on that day exceeds $0.70 (**verified**: gateway spend per day was $0.48 on 2026-10-24, $1.63 on 2026-10-25, and $0.77 on 2026-10-26; in three days, one day stayed within $0.70 and two days exceeded it), reader judgment is rejected (`budget_exceeded`) like other tier-5 calls, and then enqueued again.

**Switch** `READER_WATCH_ENABLED`:

- When it is not `"true"`: `/follow` returns 404, public pages do not show the entry to `/follow`, `createReaderWatch` returns 403 `reader_watch_disabled`, and judgment does not evaluate reader watches.
- Not affected by the switch: `revokeReaderWatch`, private RSS reads, `sweepReaderWatches`. They cost no money and only read or only disable.
- To turn the switch on, open a separate PR that changes only those lines, and get the owner's consent. Before turning it on: set the salt with `wrangler secret put IP_HASH_SALT` (at least 32 random bytes); run one offline evaluation (N§6 "limit automatic delivery to low-risk personal briefings after evaluation"), and the question set includes injection-style questions.

## 7. Publication and review

- Each section has `publish_mode = auto | review`. Finance is fixed to `review` (N§4 guardrails). Auto approval judges again in SQL, at commit time, the current section of the article (`publish_mode = 'auto'` and the slug is not `finance`). It does not look only at the configuration that was read when the analysis started (§6 "Event revision" rows 9 and 10). At launch, all sections are set to `review`.
- A review record is bound to a content version: `reviews(article_id, body_sha, decision)`. In `auto` mode a rule writes an automatic approval record.
- The public read layer reads only approved input: the event page, Brief, timeline, RSS, digest, and watch use only approved articles and the artifacts generated from them. Finance artifacts must also be reviewed before publication. The definitions of approved input, visible artifact, and publicly visible claim are in §6.
- Model output, source content, and reader input are always treated as untrusted data: sanitize markdown before rendering and allow only `http`/`https` links; every write (the admin console, and §3 "Public write entry points") validates `Origin`.
- Text written by readers (the question, criteria, and keywords of a watch) does not appear in any public page, public RSS, or loader data of a page. It appears only in the admin console, in model requests (`llm_calls.request_json`), and in the private RSS of that reader. The only public watches are those created by the admin (`adminWatchWhere` in §6 "Reader watch").
- Every Finance page shows "For reference only. Not investment advice." (N§4).
- A correction after publication is written to the `corrections` table and shown publicly on the original page (N§9 Trust).

## 8. Fetch ladder (tiers 0–3)

| Tier | Method |
|---|---|
| 0 | `content:encoded` of RSS. A source can set `summaryIsBody`, which uses the RSS summary directly as the body (arXiv uses this) |
| 1+2 | One `fetch` with `Accept: text/markdown, text/html;q=0.9`: if it returns markdown, use it directly (tier 1); if it returns HTML or PDF, hand it to `env.AI.toMarkdown()` (tier 2, supports PDF, **verified**) |
| 3 | Jina Reader: used only when the global switch `THIRD_PARTY_READER_ENABLED` is on and the source is also turned on separately |

Jina goes through the model client by the read slot, is written to llm_calls, and uses the channel jina.

Tier 1 works only for sites that turned on Markdown for Agents on Cloudflare. Both arXiv and MIT Technology Review return HTML (**verified**, measured when #6 was refined), so tiers 1 and 2 are merged into one request and do not send an extra one. The robots.txt of arXiv requires `Crawl-delay: 15`.

- Sources that need browser rendering to be fetched are not accepted (owner's decision). They are filtered out already in the source discovery stage.
- After probing a source once, record its `fetch_rung`. After 3 consecutive failures, probe again. Each article records the tier actually used.
- Check robots.txt before fetching. If it forbids, do not fetch. The limit for one body is 2 MB. EDGAR does not use the fetch ladder (see #22).
- Fetch only inside approved sources and the primary-source allowlist of each section (N§6).
- Redirects are followed manually, at most 5 hops. Every hop checks the protocol, the allowlist, and robots.txt. Within one fetch, redirects to the same host share the fetch interval of hop 0. Redirects across hosts each claim their own slot. If a slot cannot be claimed, postpone and resend the message with the remaining wait time, and after the resend start again from the article URL. A redirect that was blocked does not go to tier 3 afterward.
- When a robots.txt request fails (network error, 5xx, 429, a redirect outside the allowlist), keep the old cache and request again after 1 hour. When there is no old cache, treat everything as forbidden and also request again after 1 hour.

## 9. Data model (core tables, columns are decided at implementation)

| Table | Key constraints |
|---|---|
| `industries` | `slug` unique; `publish_mode`, `disclaimer`, `primary_domains`, prompts and thresholds (JSON, versioned) |
| `sources` | `(industry_id, feed_url)` unique; `kind rss\|html`, `fetch_rung`, `jina_enabled`, health metrics, `status active\|paused\|candidate`; `content_display full\|excerpt\|summary` (not null, default `excerpt`, added with `ALTER TABLE ADD COLUMN`, no table-level CHECK, because adding a CHECK generates a table-rebuild migration; the closed set of values is validated once on write and once on read, and an unknown value that is read is treated as `excerpt`) |
| `articles` | `canonical_url` unique; `stage`, original publish time, fetch time, `fetch_rung`, `body_sha` |
| `analyses` | `article_id` + `prompt_version` unique; five-dimension scores, content type, evidence label, total score |
| `reviews` | `(article_id, body_sha)` unique; `body_sha` cannot be empty, and when there is no body use the hash of the summary text; `analysis_id` (nullable, which analysis row was approved, §6 "Reader-visible analysis row") |
| `dlq_messages` | Original dead-letter message, source queue, failure count, replay state |
| `events` / `event_articles` | `event_articles.article_id` unique; `events.revision`; `events.withdrawn_through` (not null, default 0, §6 "Event revision"); `events.artifacts_pending_since`, `events.evidence_pending_since` (nullable, the time of the first increment after the last enqueue, §6 "Debounce") |
| `event_artifacts` | See the key in §6 |
| `claims` / `claim_evidence` | Evidence = `(article_id, body_sha, quote, start, end, stance)` |
| `digests` | `(industry_id, kind, period_start)` unique |
| `watches` / `watch_hits` | `watch_hits (watch_id, event_id, event_revision)` unique; `watches.owner_kind admin\|reader` (not null, default `admin`, ADD COLUMN, no CHECK); `watches.token_hash` unique (nullable, only reader watches have it); `watch_hits.status` adds `delivered` (hits of reader watches, which do not enter the review queue and are not public). See §6 "Reader watch" |
| `reader_watch_admissions` | `id` auto-increment primary key, `logical_key` not null, not unique; indexed by `day`; each row is one judgment attempt of a reader watch, used for the daily attempt limit (§6 "Reader watch") |
| `questions` | Ask: admin questions (`origin = 'admin'`), and, when the switch `ASK_PUBLIC_ENABLED` is on, reader questions on the event page (`origin = 'public'`, answered only to the asker who holds the token, not published). `origin` has no table-level CHECK (adding a CHECK needs a table rebuild), and writers write only these two values |
| `source_candidates` / `discovery_runs` | Discovery |
| `companies` / `filings` / `financial_facts` | EDGAR |
| `funding_rounds` | `(company_key, round_key)` unique, `superseded_by` records corrections |
| `corrections` | Public corrections |
| `llm_calls` / `budgets` / `settings` | See §6 |

**Known limitation**: `canonical_url` is unique across all sections. An article belongs only to the section of the source that collected it first, and is analyzed only with the configuration of that section. When the same article appears in the sources of two sections, the second section cannot see it. If needed later, change the analysis result to be stored by `(article_id, industry_id)`.

### Migrations

From the first time `COLLECT_ENABLED` is turned on, `articles` and all tables referenced by foreign keys no longer use "rebuild the table" migrations. Add columns with `ALTER TABLE ADD COLUMN`. If a CHECK must change, open a separate issue and design it first.

## 10. Tests, CI, and merging

- Vitest + `@cloudflare/vitest-plugin` (the former `@cloudflare/vitest-pool-workers` was renamed and deprecated, **verified**, npm). Models, Jina, and external websites all use local fake services. Tests must be able to run in CI without Cloudflare credentials.
- Local tests and `test:ssr` use `env.test` in `wrangler.jsonc` (#2). It declares only DB, BODIES, the four queues, and vars. It does not include AI, Vectorize, and send_email, because these three bindings open a remote proxy session even locally and need credentials (**verified**, #2: without `env.test`, vitest reports "Failed to start the remote proxy session"). Its `routes` and `crons` are cleared, so that the Worker used for tests is not bound to the production domain. If a new binding is needed by local tests, add it to `env.test` too. If it is not needed, use a fake object in the tests.
- An invalid search param is redirected by TanStack Router with 307 to the canonical URL, for example `/?audience=bogus` jumps to `/` (**verified**, production, 2026-10-23). The `fetch` in smoke tests follows redirects by default and sees only the final status code. To assert "no redirect", add `redirect: "manual"`.
- CI runs on the self-hosted runner on the owner's wsl host: `runs-on: [self-hosted, wsl]`. The runners are `wsl-ainews-1` and `wsl-ainews-2`, registered with `~/runners/setup.sh ainews:2` on the host and run as systemd user services. Reason: the GitHub-hosted runners were blocked by account billing (2026-10-22). This host also runs the runners of other repositories, and `_work` is not cleaned between two runs, so tests and scripts must not hard-code ports (ask the system for a free port) and must not depend on state outside the working directory. Every job must set `timeout-minutes`.
- CI (GitHub Actions, `ci.yml`): `typecheck`, `lint`, `test`, `build`, `test:ssr`. The ruleset of main requires CI to pass; only squash merge is allowed; auto-merge is on; the branch is deleted after the merge.
- The `deploy` job in the same `ci.yml`: runs migrations and `wrangler deploy` only on main, after CI passes.
- One issue, one branch, one PR. The PR body says `Closes #n`.
