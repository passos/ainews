# Daily: architecture overview

This document explains how Daily works, for a reader who is new to the code.
The binding contract for implementers is [`architecture.md`](architecture.md)
(in Chinese). If the two documents disagree, `architecture.md` wins.

Requirements come from [`Newsren_Plan.md`](Newsren_Plan.md). References like
`N§2.2` point to a section of that plan.

## 1. What the system does

Daily is a news site that runs its own newsroom pipeline:

1. It collects articles from approved sources in four sections: Technology,
   Education, Industry and Finance.
2. It scores each article and writes a short summary.
3. It groups articles about the same story into an **event**.
4. For each event it writes a Story Brief, explanations for three audiences,
   section-specific editorial products, and claims linked to exact quotes.
5. A human editor approves what goes public. Finance is always reviewed.
6. Readers can ask questions about a story and follow topics. Answers cite
   approved source text only.

## 2. System context

```
                         ┌──────────────────────────────────────────────┐
  Readers ──HTTPS──────► │  Cloudflare Worker  ainews-app                │
  (news.ioenv.com)       │                                              │
                         │  fetch      public site, RSS, /admin          │
  Editor ──Access login─►│  scheduled  cron every 10 min: pick due work  │
  (/admin)               │  queue      pipeline consumers                │
                         └──┬──────────┬──────────┬──────────┬──────────┘
                            │          │          │          │
                 ┌──────────▼──┐ ┌─────▼─────┐ ┌──▼───────┐ ┌▼────────────────┐
                 │ D1  ainews  │ │ R2 bodies │ │ Queues   │ │ Vectorize       │
                 │ all records │ │ versioned │ │ ingest   │ │ V_EVENTS        │
                 │ via Drizzle │ │ article   │ │ group    │ │ V_CHUNKS        │
                 └─────────────┘ │ bodies    │ │ generate │ └─────────────────┘
                                 └───────────┘ │ dlq      │
                                               └──────────┘
                            │                                 │
            ┌───────────────▼───────────┐       ┌─────────────▼──────────────┐
            │ Sources (outbound fetch)  │       │ Models (through one client)│
            │ RSS / HTML list pages     │       │ AI Gateway: Jev, Gemini    │
            │ SEC EDGAR                 │       │ Workers AI: bge-m3 embed,  │
            │ robots.txt, per-host rate │       │   toMarkdown               │
            └───────────────────────────┘       └────────────────────────────┘
```

Everything runs in **one Worker**. The entry file `src/server.ts` exports three
handlers:

| Handler     | Job                                                                 |
| ----------- | ------------------------------------------------------------------- |
| `fetch`     | TanStack Start app: public pages, RSS feeds, `/admin`, server functions |
| `scheduled` | Runs every 10 minutes. It only picks due work and sends it to queues. |
| `queue`     | Pipeline consumers. Messages carry a `kind` and an id; state is in D1. |

### Bindings

| Binding      | Type                       | Use                                                    |
| ------------ | -------------------------- | ------------------------------------------------------ |
| `DB`         | D1 `ainews`                | All records                                            |
| `BODIES`     | R2 `ainews-bodies`         | Article bodies, one file per version, never overwritten |
| `Q_INGEST`   | Queue, concurrency 2       | collect → body → analyze                               |
| `Q_GROUP`    | Queue, concurrency 1       | Group articles into events, in order                   |
| `Q_GENERATE` | Queue                      | Event artifacts, claims, watches, digests, Ask         |
| `Q_DLQ`      | Queue                      | Dead letters. Stored in a table; the admin can replay them |
| `V_EVENTS`   | Vectorize, 1024 dimensions | Find candidate events for a new article                |
| `V_CHUNKS`   | Vectorize, 1024 dimensions | Body chunks for Ask and claim evidence                 |
| `AI`         | Workers AI                 | Model calls (with AI Gateway), embeddings, `toMarkdown` |

## 3. The pipeline

```
cron (10 min)
   │
   ▼
Q_INGEST ── collect(source) ──► body(article) ──► analyze(article)
              RSS/HTML parse      fetch ladder      prefilter      (Jev)
              URL normalise       rung 0: feed      5 scores       (Jev)
              dedupe              rung 1+2: fetch   labels         (Jev)
                                  + toMarkdown      title, summary (Gemini)
                                                         │ selected
                                                         ▼
Q_GROUP ─── group(article): embed → Vectorize recall → Jev picks event or new
                                                         │ event.revision + 1
                                                         ▼
Q_GENERATE ─ artifacts(event)  Story Brief, 3 audiences, section products
             evidence(event)   claims + verbatim quotes, checked in code
             watch(event)      does this change match a saved question?
             digest(section)   daily and weekly briefings
             ask(question)     answer from approved chunks only
                                                         │
                                                         ▼
                              editor review ──► public site, RSS
```

Each article has a `stage`: `collected → body_ready → analyzed → grouped`, or
`dropped`. Every 10 minutes the cron re-queues rows that have not moved for 30
minutes. A repeated message skips stages that are already done, so a consumer
can safely run twice.

### Deterministic code versus model calls

The plan asks for fixed steps in code and model calls only where judgement is
needed (N§1, N§6).

| Step                                         | How                          | Model slot      |
| -------------------------------------------- | ---------------------------- | --------------- |
| Schedule, parse feeds, dedupe, robots.txt    | Code                         | —               |
| Relevant or not, 5 scores, content type, evidence label | Jev structured judgement | `judge`   |
| Weighting, thresholds, publish mode          | Code                         | —               |
| Title and summary                            | Gemini 3.8 Flash             | `write`         |
| Which event an article belongs to            | Vectorize recall, then Jev   | `embed`, `judge` |
| Story Brief, explanations, learning material | Gemini 3.8 Flash             | `write`         |
| Claims and evidence                          | Gemini 3.8 Flash, then code checks every quote is in the body | `reason` |
| Ask, section reports                         | Gemini 3.8 Flash             | `reason`        |
| Watch: is this a material development?       | Keyword rules, then Jev      | `judge`         |
| Earnings numbers                             | Code (SEC XBRL values)       | —               |

Slots are stored in the `settings` table, so the admin can change a model
without a code change.

### Body fetch ladder

| Rung | Method                                                              |
| ---- | ------------------------------------------------------------------- |
| 0    | Full text in the feed (`content:encoded`), or the feed summary for arXiv |
| 1+2  | One `fetch`. Markdown is used directly; HTML or PDF goes to `toMarkdown()` |
| 3    | Jina Reader. Off: it needs a switch, a per-source flag and a budget |

The fetcher checks robots.txt first, keeps the crawl delay per host, uses the
project user agent, and fetches only from approved source domains. Sources
that need a browser to render are not accepted.

## 4. Events and revisions

An **event** is one story. Articles join it as they arrive.

- Grouping runs with concurrency 1, so two articles cannot create the same
  event at the same time.
- Each time the set of approved articles in an event changes, `events.revision`
  goes up by 1.
- Every artifact records the revision it was built from (`input_revision`).
  The site shows only artifacts for the current revision, and a late job for
  an old revision cannot overwrite a newer result.
- The Timeline on an event page lists the reports in the order they arrived:
  "First report", then "New report" with what each one added.

### Artifacts by section

| Section    | Artifacts (in addition to Story Brief and three-audience explanations)              |
| ---------- | ----------------------------------------------------------------------------------- |
| All        | `story_brief`, `audience_explain` (student, educator, professional), `learning_material` |
| Technology | `research_paper_decoder`, `launch_reality_check`, `technology_evolution_timeline`    |
| Education  | `education_evidence_checker`, `classroom_discussion_builder`, `policy_impact_explorer` |
| Industry   | `industry_impact_report`, `supply_chain_ripple_map`, `skills_career_trends`          |
| Finance    | `regulation_watch`, `finance_concept_explainer`, `finance_reality_check`, `earnings_decoder` (needs SEC filings; none stored yet) |

Each artifact type has a schema (zod). Model output that does not match the
schema is not stored.

## 5. Evidence and trust

- **Claims.** The reasoning model extracts claims and quotes from the article
  body. Code then checks that each quote appears verbatim in the stored body
  version (`bodies/{article_id}/{sha256}.md`). A quote that is not found is
  dropped.
- **Labels.** Every claim and article carries an evidence label (fact, vendor
  claim, preprint, opinion, and so on). Model judgements are labelled as
  "model assessment" on the page.
- **Provenance.** Every item shows its source, its publication time and its
  retrieval time (N§6).
- **Corrections** are stored in a table and shown on the original page.

## 6. Reader features

### Ask about this story

```
reader question ──► limits (switch, 30/day global, per-question cost cap)
                ──► embed question ──► V_CHUNKS recall, approved articles of this event only
                ──► Gemini answers with quotes
                ──► code checks each quote verbatim against the body
                ──► answer + "verified" / "could not verify" per quote
```

- The answer is labelled "Model answer · not editor-reviewed".
- Public Ask never fetches new pages and is not offered in Finance.
- Admin Ask (`/admin/ask`) uses the same answer code.

### Follow a topic (watches)

- A watch is a saved question with criteria and keywords. Admin watches are
  public at `/w/<slug>`; reader watches are private and delivered by a
  private RSS link.
- When an event changes, keyword rules filter first, then Jev decides whether
  the change is a **material development**. Commentary does not count.
- A watch judges only articles approved after the watch was created, and the
  same development never fires twice (`watch_hits` is unique per watch, event
  and revision).

## 7. Publication boundary

```
           pipeline/**  providers/**      (may call models)
                 │ writes
                 ▼
               D1 / R2
                 │ reads, filtered by approvedArticleWhere
                 ▼
     server/publication/**  ◄── routes/**  (public pages: no model access)
```

- Public pages and RSS read data only through `src/server/publication/`.
  "Approved" has one definition: `approvedArticleWhere`.
- An architecture test (`tests/architecture.test.ts`) fails if a route or the
  publication layer imports pipeline or provider code, directly or indirectly.
- A review is bound to a body version: `reviews(article_id, body_sha)`. If the
  body changes, the article needs a new review.
- Each section has `publish_mode = auto | review`. Finance is always `review`
  and every Finance page shows "informational, not investment advice" (N§4).
- An editor can remove a published article (`/admin/published`). The event is
  rebuilt from the remaining articles.

## 8. Cost control

```
 caller ─► createModelClient(tier) ─► ledger row (logical key, pending)
                                 ─► reserve budget: one conditional UPDATE
                                    reserved + spent + estimate + floor(tier) <= cap
                                 ─► call model ─► settle actual cost
```

- **One client.** Every model call goes through `createModelClient()` in
  `src/providers/models.ts`. Code never calls `env.AI.run` directly.
- **Ledger.** `llm_calls` has a unique logical key per call. A repeated job
  gets the stored answer instead of paying twice. The admin sees every call
  and its cost at `/admin/ledger`.
- **Daily caps per channel**, in integer micro-USD: `gateway`, `workers_ai`,
  `jina`.
- **Five tiers** inside the gateway cap. Tier 1 (scoring, grouping) is
  protected first; tier 5 (digest intros, reader watches) stops first. When a
  tier is full the call is not sent and the work waits for the next day.
- **Switches.** `COLLECT_ENABLED`, `MODEL_CALLS_ENABLED`, `EMAIL_ENABLED`,
  `THIRD_PARTY_READER_ENABLED`, `DISCOVERY_ENABLED`, `READER_WATCH_ENABLED` and
  `ASK_PUBLIC_ENABLED` are on only when the value is the string `"true"`.

## 9. Data model

| Table                                   | Holds                                                          |
| --------------------------------------- | -------------------------------------------------------------- |
| `industries`                            | Sections: slug, publish mode, disclaimer, prompts, thresholds   |
| `sources`                               | Feeds per section, fetch rung, health, status                  |
| `articles`, `article_sightings`         | One row per canonical URL; stage, times, body version          |
| `analyses`                              | Scores, content type, labels, title, summary per prompt version |
| `reviews`                               | Editor decision per article and body version                   |
| `events`, `event_articles`              | Stories and their articles; `revision`                         |
| `event_artifacts`                       | Generated products, keyed by event, type, audience, revision   |
| `claims`, `claim_evidence`              | Claims with verbatim quotes and stance                         |
| `watches`, `watch_hits`                 | Saved questions and their hits                                 |
| `questions`                             | Ask questions and answers (admin and public)                   |
| `digests`                               | Daily and weekly briefings                                     |
| `companies`, `filings`, `financial_facts` | SEC EDGAR data for the Earnings Decoder                      |
| `corrections`                           | Public corrections                                             |
| `llm_calls`, `budgets`, `settings`      | Ledger, daily budgets, model slots and settings                |
| `dlq_messages`                          | Dead-letter messages for replay                                |

Migrations only add columns or indexes. Tables that other tables reference are
never rebuilt.

## 10. Security

- `/admin` is behind Cloudflare Access. Server functions live under
  `/_serverFn/*`, outside `/admin`, so each admin server function checks the
  Access identity itself.
- Every write is a POST and passes an Origin check in `src/server/edge.ts`.
  Non-GET server-function bodies are capped at 64 KB.
- Model output and source content are untrusted: Markdown is sanitised before
  rendering and only `http`/`https` links are allowed (`safeHttpUrl`).
- Text that readers write (watch questions, Ask questions) never appears on a
  public page. Network addresses are stored only as salted hashes.

## 11. Code map

| Path                        | Content                                              |
| --------------------------- | ---------------------------------------------------- |
| `src/server.ts`             | Worker entry: `fetch`, `scheduled`, `queue`          |
| `src/routes/`               | Pages: `/`, `/s/$section`, `/a/$id`, `/e/$id`, `/w`, `/follow`, `/digest`, RSS, `/admin/*` |
| `src/components/`           | UI components                                        |
| `src/server/publication/`   | Read layer for public pages                          |
| `src/server/admin/`         | Admin server functions and Access check              |
| `src/server/reader-ask/`, `src/server/reader-watch/` | Public write entry points    |
| `src/server/edge.ts`        | Origin check, size cap, response headers             |
| `src/pipeline/`             | collect, body, analyze, group, artifacts, evidence, watch, digest, ask, edgar |
| `src/providers/`            | Model client, ledger, budget, tiers, adapters        |
| `src/server/db/schema/`     | Drizzle schema; migrations in `drizzle/migrations/`  |
| `tests/`                    | vitest (`workers` and `node` projects), SSR smoke    |

## 12. Testing and delivery

- `npm test` runs vitest in two projects: Workers runtime tests against a
  local D1, and Node tests in two time zones. Tests never call real services:
  every switch is off in the `test` environment.
- `npm run test:ssr` builds the app and checks server rendering of the main
  routes.
- CI runs on every pull request. A merge to `main` runs CI, applies D1
  migrations and deploys the Worker.
- Each change is one issue, one branch, one squash-merged PR, reviewed by a
  model from a different family than the author.

## 13. Known limits

- An article belongs to the section of the first source that collected it.
- arXiv URLs with and without a version suffix (`v1`) can be stored twice
  (#181).
- Email briefings exist in code but are off: the sending domain is not set up.
- The Funding Tracker (#23) and reader analytics (#24) are not built.
