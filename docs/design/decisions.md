# Scope decisions (2026-10-22)

Source: exported at the bottom of design draft v0.2 (`core-design.html`). The owner pasted it back into the conversation. It is saved as is.
The owner added one more requirement: finish Stage 1–4 of the Newsren plan within this week.

Rule for conflicts with the scope lines below (the owner must still confirm it; see `docs/plan/week-plan.html`, section 01):
The Q answers and "do all of Stage 1–4" take priority over the scope lines.

```
ainews scope decisions (* = changed from the recommendation)

## v1
- Collect RSS / Atom
- Collect web list pages
- JS-rendered pages
- Body fetch ladder
- Dedup
- Pre-filter
- Scoring and thresholds
- Summary and headline rewrite
- Event grouping
- Daily digest
- Public website
- RSS output
- Manual override
- Model call ledger
- Multiple industries
- AI-drafted industry config
- AI source discovery
- Source health monitoring
- Daily digest email *
- Four seed sections
- Item-level provenance
- Evidence type labels
- Story Brief
- Three-tier explanations
- Pre-publication review
- Finance safety boundary
- Event timeline
- Trace to primary source *
- Follow a Topic *
- Claim-level evidence *
- Classroom materials *
- Industry impact report *
- API-type sources *
- Credibility and cost dashboard *

## Later
- Weekly / monthly report
- Automatic enabling of candidates
- Periodic re-discovery
- Threshold calibration
- On-site search
- Ask Newsren

## Not doing
- Model leaderboard
- X / WeChat official account sources
- Discussion-thread heat signal
- Feishu push
- IndexNow submission
- Curated ledger + incremental sync API
- Public JSON API *
- MCP / Agent Markdown *
- Module plugin system
- Visitor feedback
- Full-text translation
- Image proxy / OG image
- Multiple admins / roles

## Questions
- Q1 · Who is the website for? Public reading; only the admin area needs login
- Q2 · How does the admin log in? Own domain on Cloudflare: Access protects /admin only *
- Q3 · Output language? English only *
- Q4 · How are AI-discovered sources enabled? Sources that pass the evaluation are enabled automatically; I can disable them later *
- Q5 · What recalls candidate events for event grouping? Vectorize + embeddings from v1 *
- Q6 · How are models paid for? AI Gateway Unified Billing: prepaid credits, one bill
- Q7 · Report cadence? Daily + weekly *
- Q8 · Expected scale? ≤ 5 sections, ≤ 50 sources each
- Q9 · Site name? Personal News
- Q10 · Which section runs first, and which must-watch sources do you already know? Technology, arXiv, cs.ai, MIT Technology Review
- Q11 · What form does Ask Newsren take? In v1, only the admin uses it, in the admin area *
- Q12 · What form does Follow a Topic take? The admin creates topics; each topic has a public page and an RSS feed
- Q13 · Does the fetch ladder use a third-party free reader (tier 3)? Use Jina Reader; the global switch is off by default; it can be turned on per source
- Q14 · Where is the fetched body stored? In R2, kept long term *
```

# Technical and execution decisions (2026-10-22, round 2)

The owner's original text:

```
1. Use the cloudflare account named simon
2. Use TanStack for the tech stack, using follow instruction
   Build a TanStack Start application with file-based TanStack Router routes, validated search params, route loaders, typed server functions, full-document SSR, and streaming. Keep server-only work behind explicit boundaries, choose the appropriate SSR mode per route, and target the deployment runtime without changing the application model.
3. Deploy on a single cloudflare worker, using D1 + Drizzle + R2, domain name news.ioenv.com , admin email simon.jinyu.liu@gmail.com , I will set up the zero trust app in the dashboard myself, and I will top up AI Gateway myself
4. Fixed processes use deterministic scripts and logic. Quick judgments use Jev as the judgment model. For the rest, consider google gemini 3.8 flash, Claude sonnet 5.5, or an equivalent OpenAI model
5. Open an epic issue + sub-issues for all planned work on githonllc/ainews, with PR + CI + auto merge
6. JINA_API_KEY, CF_AI_API_TOKEN, CLOUDFLARE_ACCOUNT_ID are stored in .env.prod
7. AIHOT is a reference project. @docs/Newsren_Plan.md holds the real project requirements and must be met. Reader email subscription comes later. For now, do not consider content that needs a Browser to fetch. Prefer content sources that the free quotas of jina and CF can support
8. Do not worry much about the timeline. Break down and schedule tasks by the priority of finishing everything. You may follow the arrangement of option A, but do not cut the most time-consuming core feature (it may be delayed)
CF worker name ainews-app
```

Changes to round 1 that follow from this:

- The deadline is cancelled. Work is scheduled by milestones M0–M4 (`docs/plan/week-plan.html`).
- "JS-rendered pages" and fetch ladder tier 4 (Browser Run) move to later. Sources that need a browser to fetch are not accepted.
- The four readings in section 01 of round 1 apply as follows: Ask is admin-only; the weekly report is in v1 and the monthly report is later; sources that pass are enabled automatically, with a cap; the daily digest email goes to the admin only, and reader email subscription is later.
- For the tech stack, `docs/architecture/architecture.md` is authoritative. It replaces section 04 of week plan v1 and the Hono-related items in the review file.

# Round 3 decisions (2026-10-22)

- **The two Newsren gaps follow the recommendation** (the owner's words: "do both gaps as recommended"):
  - N§2.1 My Newsren: reader preferences live in the reader's own browser (`localStorage`). They are not sent to the server. They include the explanation tier, followed sections, and saved watches. The spec is in #10 and #17.
  - N§9 Usefulness: under each Story Brief and each daily digest, show two buttons, "useful / not useful". They are anonymous and take no free text. This is the only write entry on the public site. The raw IP is not stored. One person counts for one vote per item per day. The spec is in #24.
- The **AI Gateway** id is `ainews`. The owner has already created it.
- **Deploy credentials**: a new Account API token `ainews-deploy` was created. The old personal token is no longer used for this project. `.env.prod` and the GitHub secret `CLOUDFLARE_API_TOKEN` both use the new token.
- **CI runs on self-hosted runners on the owner's wsl host** (`wsl-ainews-1`, `wsl-ainews-2`). The reason is that billing blocks the GitHub-hosted runners.
- **The owner sets up the Zero Trust app and Web Analytics.** The AUD tag, the team domain, and `CF_BEACON_TOKEN` go into vars after the owner provides them.
- **Division of work**: the ainews-design session does design and review; the ainews-impl session does implementation and transactional operations (push, open PR, merge, deploy, change repo settings).

# Round 4 decisions (2026-10-23)

- **The daily model budget is $2**, split by channel: `gateway` $1.90 (Jev, Gemini, Sonnet), `workers_ai` $0.10 (embeddings), `jina` $0. The seed data from #3 is already in the production database. Change it later in the admin area (#9).
- **Jev is billed from AI Gateway credits** (the owner confirmed this in the Gateway logs). The billing channel of the embedding model bge-m3 is not confirmed yet. It is a to-do in #9.
- **ainews-impl creates the Zero Trust app through the API**: `ainews-admin`. It protects only `news.ioenv.com/admin`, allows only `simon.jinyu.liu@gmail.com`, and has a 24-hour session. After the owner logged in, the admin page and Check session both showed the email. M0 is complete.
- **Known limitation**: architecture tests R1/R2 check direct imports only. They do not check transitive imports (indirect imports of `server/db` or `providers/` through `components/` or admin helpers). Open a separate issue later to fill this gap.

# Round 5 decisions (2026-10-23)

- 2026-10-23, the owner decided: do not use Sonnet. `reason` uses Gemini 3.8 Flash (fallback: OpenAI gpt-6-luna). See #53.
- 2026-10-23, ainews-design decided: the Q_INGEST consumer concurrency limit is 2. This stops bursts of calls from triggering gateway rate limits when the backlog queue is full (32 errors 2018 at 05:42Z). See #53.

# Round 6 decisions (2026-10-26)

The owner's words (2026-10-26): "Take the requirements document @docs/Newsren_Plan.md as the standard. You make the best product and user-experience decisions for me. I adopt all your recommendations".
Then the owner added: "Note in particular: your decisions focus on product and user experience, not on the easiest solution, the lowest-cost solution, or the lowest-risk solution".
Each item in this round is **decided by ainews-design on the owner's behalf**. The basis is the two sentences above and `Newsren_Plan.md` (N). The trigger was the full review on 2026-10-26:
15 PRs were merged with zero review, and readers can hardly see the merged M2–M4 features on the live site. Two reviewers reviewed it. Both are from the Anthropic family, marked [degraded].

## Review and publishing (N§6 "Require human approval for publishing initially", N§4 "Human editorial review for any finance story")

- Generated content must still get human approval before it reaches readers. This rule is not relaxed. What changes is the cost of approval:
  - **One-click approval at event level**: one action publishes all artifacts of the event's current revision, and the claims that have a verified source snippet. Finance is still approved item by item.
  - **A published version stays only when "the set of approved articles only grows"**: a new revision produces a new version that waits for review. The old version stays visible until the new version is approved.
    Rejecting an article, a manual rewrite, a section change, or a re-analysis must take down the old version at once, in the same `batch()`.
  - **Debounce**: regenerate only events whose revision has changed and whose `updated_at` is at least 30 minutes old. One review session triggers it once.
  - **Claim guard**: a claim with no verified source snippet cannot be approved and cannot be made public.
- **Daily and weekly reports**: items are published automatically, but they use only the title and summary of the approved article itself. The model-written `one_liner` and lead go through a separate review. They show only after approval.
  Finance daily and weekly reports are published by hand as a whole. The admin email waits until Email Service is connected. So #12 is reopened, and it states that this item is not finished.
- **There is only one definition of "approved"**: about 20 inline copies in the pipeline are all replaced by `approvedArticleWhere`.

## Reader features

- **Artifacts for every event** (N§7 "one-click student, educator, and professional explanations"): every selected event gets a Story Brief,
  three-tier explanations, learning materials, and the editorial products of its section. There is no score threshold. The scheduler and the build share one eligibility function.
- **Generated content always carries its sources** (N§6 Critical product requirements, item 1): Story Briefs, three-tier explanations, and learning materials must show the source articles, the publish time, and the fetch time.
- **Ask is open to readers** (N§7 Stage 2 "Readers get useful, evidence-backed answers", N§1 Reader loop): this item replaces "Ask is admin-only" from round 2.
  - Entry: every event page has "Ask about this story". The answer relies only on the approved body of that event and cites it sentence by sentence. When it finds nothing, it says what it could not find.
  - The answer goes only to the person who asked. It is not published on a public page. The rate limit is set per network address. It only guards against abuse.
  - **Separate budget, server-side switch** (the owner's words, 2026-10-26: "Reader ask uses a separate budget, and the server-side feature flag controls whether it is enabled"):
    - Reader Ask calls are booked to a separate budget channel `ask`. They do not use the $1.90 of `gateway`. When `ask` is used up, that day's Ask shows "Today's question quota is used up" and the pipeline is not affected.
    - New switch `ASK_PUBLIC_ENABLED`. Like the other safety valves, it accepts only the string `"true"`. The default is `"false"`. When it is `"false"`, the public pages show no entry and the server rejects requests.
    - The owner decides the daily quota of `ask` and the time to turn the switch on, when turning it on. The switch change is a separate PR. Ask in the admin area still uses the existing channel and is not affected by this switch.
  - A precondition for opening it is an offline evaluation (N§6 "after evaluation"): on the question set, both citation accuracy and refusal accuracy must reach the target.
  - v1 does not include the Finance section (N§4 "no personalized investment advice").
  - The `questions` row of the contract `docs/architecture/architecture.md` changes in a separate PR.
- **Reader-created follows** (N§2.1 highest priority, N§2.6, N§7 "Follow a Topic: save specific questions"): the reader does not register.
  The reader writes the question to follow and the match condition in natural language, and the system gives a private RSS address. It hits only when there is substantive progress. The same progress never hits twice.
  Watches created by the admin stay as public examples, and the public site gets a list entry for them. Email push waits until reader subscription is built.
- **Fill the N§3 Technology editorial products**: Launch Reality Check, Technology Evolution Timeline. Technology is the only section with data now.

## Article reading page (the owner's words, 2026-10-26: "While keeping the original link, I want to save the fetched content on the server and show it by default after formatting")

- Add the public page `/a/$articleId`. Article titles on the home page, the section pages, and the event pages link to this page by default. Every card and the reading page keep the original link "Read the original at {source}".
- The page, top to bottom: title; source, publish time, fetch time; original link; AI summary with an "AI summary" label; formatted body; the original link again at the bottom.
  A Finance article page shows the disclaimer (N§4).
- The body shows only the approved version (`reviews.body_sha`), through `approvedArticleWhere`. When R2 has no body, fall back to the summary plus the original link.
- Rendering: convert markdown to HTML on the server and sanitize it with an allowlist. Links allow only http/https (`safeHttpUrl`). External links get `rel="noopener nofollow"`.
  Images allow only https and get `loading="lazy"` and `referrerpolicy="no-referrer"`. Remove script, iframe, form, and style.
  Layout: body width of about 68 characters; full styles for headings, quotes, code, and tables; tables scroll horizontally; do both light and dark; no horizontal scroll at 375px.
- `<link rel="canonical">` points to the original.
- Evidence linking: every quote in Inspect evidence links to `/a/$id#:~:text=…`, so the reader sees the highlighted passage on this site. The original link stays too.
- **Copyright (N§6 Editorial quality gate, "licensing")**: each source gets a new display mode with the value `full`, `excerpt`, or `summary`.
  - `full`: show the full text.
  - `excerpt`: show the first paragraphs, at most 25% of the body and at most about 300 words, then "Continue reading at {source}".
  - `summary`: show only the summary.

  The new column defaults to `excerpt`. The value for each source:
  - Government and public-domain sources (Federal Reserve, SEC, FINRA, NIST, ed.gov, NCES, CISA) use `full`.
  - arXiv uses `full`: what is stored now is the abstract, and arXiv metadata (including abstracts) is CC0.
  - Commercial media (MIT Technology Review and others) use `excerpt`.

  The admin can switch any source to `full` in the admin area, provided it is confirmed that the other side allows reprinting.

- RSS: item links change to `/a/$id`, and the description carries the original link. The guid does not change.
- This page does not call a model and does not use the daily budget. It is the first item of W2.

## Funding Round Tracker (#23, N§3 line 104, N§4)

- Model extraction produces proposals only. Admin approval is the only way to write to `funding_rounds`. A proposal itself cannot be modified; a new report produces a new proposal.
- The admin has four actions: approve as a new round; approve as a correction of published round X; reject; withdraw a published round.
  - Approve and reject of a proposal both carry `WHERE state='pending'` and are chained with `changes()=1`.
  - A correction row = all fields of X, overwritten by the fields the proposal's source text states explicitly.
  - `superseded_by` can be written from NULL only once. Decide the write order after testing the foreign key behavior.
  - Check before approval: all source articles are already approved.
- Admin experience: each proposal is pre-matched to the most likely published round. It lists the differences field by field, with the source snippet that supports each field.
- Reader experience: `/funding` can filter by section, stage, and investor, and it shows trends. Every number links to the source snippet. A corrected record shows the correction time and reason. Startups are not ranked.
- Field policy: record only the fields the source text states explicitly. Identity is set by three items: company, specific round, and announcement date. When one is missing or in conflict, the admin decides on the proposal.

## Sources (N§7 Stage 1 "Approved source feeds")

- Every section needs both primary sources and independent reporting, so that a vendor's claims can be compared with independent evaluations. Candidates:
  - Technology adds: vendor primary news pages (OpenAI, Google DeepMind, Anthropic), independent evaluation (Epoch AI), CISA security advisories.
  - Education: The Hechinger Report, EdSurge, ed.gov news, NCES.
  - Industry: Supply Chain Dive, Manufacturing Dive, NIST news.
  - Finance: Federal Reserve press releases, SEC press releases, FINRA news, TechCrunch Venture.
- Verify every candidate with the project UA: robots, feed, and body fetch ladder. It passes only if no browser is needed. ainews-design picks the list from those that pass.
  When writing to production, run a dry-run first, run it once, and post the counts before and after.

## Money and switches

- **The daily budget is still $2** (the owner's words, 2026-10-26: "Run the budget at $2"): `gateway` $1.90, `workers_ai` $0.10, `jina` $0.
  All the reader features above stay within this cap. So the design side adds one rule: **allocate the budget by reader value**. When the quota is not enough, the items ranked first are served first:
  1. Article pre-filter, scoring, and summary (Stage 1);
  2. Story Brief and three-tier explanations of approved events;
  3. Claims and evidence;
  4. Learning materials, section editorial products, watch judgment;
  5. Leads of the daily and weekly reports.

  Reader Ask is not in this ranking. It uses the separate `ask` budget (see above). When the quota is used up, the later tasks queue until the next day. No data is lost. The admin budget page must show the spend of each tier for that day.

- For all new write and reason calls, run one batch of real probes to confirm `finishReason=STOP`. The expected cost is at most $0.10.
- `DISCOVERY_ENABLED` stays `"false"`. Before it is turned on again, these must be met: the probe obeys crawl-delay, carries the project UA, and checks robots across hosts;
  there is budget for the day; websearch is booked through `createModelClient`. Changing this switch still needs a separate PR and the owner's consent.

## Process

- Before each PR is merged, leave a comment on GitHub with the two reviews, marked [degraded] when it applies. Merge with `--match-head-commit`, bound to the reviewed head.
- The migration number 0020 conflicts between #23 and #24: the one merged later rebases and runs `db:generate` again.
- The content of the 5 `/private/tmp/ainews-review-*` worktrees is already on main. Clean them up with `git worktree remove`.

## Still to be done by the owner by hand

- When Reader Ask is turned on, set the daily quota of the `ask` budget and agree to the PR for the `ASK_PUBLIC_ENABLED` switch.
- Connect Email Service on `ioenv.com` and confirm the sender address.
- Provide credentials that can read the AI Gateway logs, for the reconciliation at the M1 gate, and confirm the billing channel of embed.

# Round 7 decisions (2026-10-26)

W1 (#80–#86, #92, #95) was finished and deployed in this round. Except for items marked "the owner's words", all items are **decided by ainews-design on the owner's behalf**, with the same authority as round 6.
The numbers in parentheses after each item are the issue and PR that implement it.

## Site and language

- **The site name changes to Daily** (the owner's words: "Change the name of the whole website from Personal News to Daily"). The site name that readers see is defined once, as `SITE_NAME` in `src/lib/site.ts`.
  The fetch UA is `DailyBot/1.0 (+https://news.ioenv.com)`. (#89, PR #91)
  - The model prompts still have 17 occurrences of "Personal News" (14 in `src/pipeline/artifacts/prompts.ts`, 2 in `digest/prompt.ts`, 1 in `evidence/prompts.ts`).
    Readers cannot see them. **They are not changed this time**: changing the prompt text changes the prompt hash, and all existing artifacts would have to be regenerated at a cost. The next time these prompts are changed for another reason, replace them together.
  - Also renamed: `SEC_USER_AGENT`, README, AGENTS.md, and architecture.md. Not renamed: the repo name, the Worker name, the domain name,
    the browser storage key `pn:prefs:v1` (a change would lose reader settings), and the original requirements file `Newsren_Plan.md`.
- **All text that readers can see is in English** (the owner's words: "When you improve the UI, remember that the whole website uses English only").
  The scope includes email, RSS, empty states, and disclaimers. No Chinese font is loaded. CI scans `src/components`, `src/routes`, `src/lib`, and `src/server/publication`.
  Outside comments, no Chinese may appear in strings or page text. Admin pages are not scanned. (#95, PR #96)
- **The UI uses the e-ink style** (the owner's original words are in #87; the owner added: "The e-ink option looks much better. Adopt it. Also borrow from the page style of the fastcade project's
  landing page. But for fonts, choose fonts suited to reading"). Mock v2: <https://claude.ai/artifact/Lfc3QdrDPknc2twUejatuL>.
  - The main colors are grey and white. Remove the accent color of each section and keep only one low-saturation semantic color. If this conflicts with the TASTES item that prefers saturated colors, the owner's words win.
  - The layout borrows from the fastcade landing page: a 5:4 asymmetric first screen, one large element per screen, 3px solid lines, full-width grey bands, right angles.
    It does not borrow its colors, slanted layout, or sans-serif large headings. The home page's card for the current day holds real data only.
  - Fonts: Newsreader for headings, Literata (self-hosted) for body text, and a system sans-serif for interface controls.
  - New hard-coded color classes must not exceed the baseline. This item goes in the last wave (W5). The favicon must change to the same style, and the console must not report a `/favicon.ico` 404 any more. (#87)

## Source names (#80, PR #93)

- An article with no real source (for example a primary document) is attached to the placeholder source `feed_url='system:primary-documents'` under its own section.
  The placeholder source has status `paused` and no `site_domain`, so collection never claims it. It is created the first time it is used.
  We do not use "skip if no source matches", because that would drop most primary sources (N§2.5).
  The source column on public pages shows the domain of the document. The public source list does not show the placeholder source.
- When the admin creates or edits a source, or approves a candidate source, `feed_url` must not start with `system:`. Trim leading and trailing spaces first, then check, case-insensitive. A violation returns 400.
  The SQL carries the same condition as a second line of defense.

## Definition of "approved" (#84, PR #101)

- There is only one definition: `APPROVED_ARTICLE_SQL` / `approvedArticleWhere`. The three constants below are exceptions. Each may appear only once in the allowlist:
  - `ANY_BODY_APPROVED_SQL`: does not require the body version to match. It is used only for orphan recovery of evidence. In the whole repo only `src/pipeline/evidence/primary.ts` may use it, once.
    Whether to tighten it is decided in #103.
  - `APPROVED_BY_SQL`: the reading page must return the approver, so the EXISTS form cannot be reused.
  - The copy in `CARD_COLUMNS`: the aliases are `a2`/`r2`.
- The test `EXPECTED_USES` fixes how many times each pipeline file references this definition. If any one is deleted, the test turns red.
  Nine files still lack behavior tests, and one more copy exists in the admin TypeScript. Both are recorded in #102.

## Article reading page (#86, PR #97)

- There are three summary labels: "AI summary", "Editor's summary", "Summary from {source}".
  The credit line in full mode is "Original text by the authors, as published by {source}."; the link text on an evidence quote is "Highlight in original ↗".
- `excerpt` mode shows no images. The word count counts only words that contain a letter or a digit, and image alt text counts too.
- HTML sanitizing: only `svg` and `math` treat `/>` as self-closing; after the name of an end tag there must be a space, `/`, or `>` right away;
  for an empty element, only the tag itself is removed; the scan is linear, and a malicious 200 KB body must render within 500 ms.
- When an R2 read fails, the page shows the summary and the original link and returns 200.
- If an evidence quote appears in an excerpt, mark it separately. This is done in W2. (#100)
- When an evidence quote falls outside the displayed range, link to `#:~:text=` of the original and say so. Do not show body text beyond the copyright range on this site.
- When arXiv uses `full`, the page keeps both the AI summary and the author's original text, and puts a small heading "Abstract" before the original text.
  Switching to `full` needs a production database write. The SQL and the dry-run are ready, **waiting for the owner's consent**.
- Change the article links in the watch page to `/a/$id`. This is done in W3.

## Re-analysis (#81, PR #108)

- Re-analysis does not delete the ledger. It adds 1 to the article's `analysis_generation`. This value goes into the ledger key of all analysis calls, so old answers are never returned.
  The old `llm_calls` and `analyses` rows are kept. When generation is 0, the key is byte-for-byte the same as before, so existing articles are not re-analyzed at a cost after deployment.
- When changing the stage, both conditions must hold: "expected old stage" and "expected generation". When an analysis result is committed, the generation is checked too. A result overtaken by a newer re-analysis is not written.
- Request parameters are validated with zod. A missing `expectedStage` returns 400.
- **Known behavior, accepted**: if the admin clicks again while the previous run is not finished, the call in progress is still billed. #81 already rejected the lease approach.
- Goal: until the new analysis result is approved, the article summary that readers see stays the old approved version. The current state achieves this only "before the new analysis is stored":
  once the new analysis row is stored, `CARD_FROM` on the public page picks the latest row, and the summary is replaced without review (#109 (c)). This gap goes into the W2 review-experience issue.
- Follow-up problems are recorded in #109: when to add 1 to the event revision; a placeholder body is written when an EDGAR document fetch fails; the rule for the "latest analysis row" differs across the public page, the admin area, and the artifacts.

## EDGAR revisions (#83, PR #106)

- `financial_facts.superseded_by` means: "among the newer, approved revision filings, the latest fact". The match condition is the same company, concept, unit, and `period_end`,
  and a different filing. On each approval or rejection, recompute it as a whole from the current review state, with one statement in the same `batch()`.
  The result depends only on the current state, not on the order of approvals. The only reader checks just whether this field is NULL.
- If the body changed on re-fetch, the article returns to the review queue. Until the new version is approved, the numbers of the original filing stay hidden (N§6).
- The item "`superseded_by` is written only once" in round 6 applies to `funding_rounds` only. The revision pointer of filings must roll back on reject or withdrawal.
- Known gap: after a revision is approved, the revision of the original event does not add 1, so the event artifacts are not regenerated because of the revision. This is done in the W4 EDGAR follow-up.

## Event grouping (#82, PR #88)

- The branch that creates a new event is also chained with `changes()=1`. On message redelivery it returns `already_grouped` and no longer adds 1 to the event's revision.
- The risk that "artifacts are generated for the new revision before the re-analysis result is stored" is handled by the W2 debounce and recorded in #109.

## Watch hits (#85, PR #105)

- Hits in all sections go to pending review first, `auto` sections too (design ruling 1): the hit summary is written by a model.
- The public site header shows the Watches entry only when a watch exists.
- Do not check the revision when writing a hit: a hit means "progress appeared at revision R". If the article is taken down later, the "approved" condition of the public page blocks it.
- Dedup: each watch first drops the articles it already cited. If no article is left, no model is called. A new watch looks only at articles approved after its creation (`created_at`, not `updated_at`).
  The ledger key includes the hash of the set of articles actually sent for judgment.
- Accepted: an article approved in the exact same millisecond as the boundary of the previous evaluation is missed.

## Scheduling (#92, PR #107)

- The three schedulers (artifacts, evidence, watch) all select events with `enqueueDueEvents`: it selects only events whose current revision has no terminal result yet.
  The order is `<kind>_scheduled_at ASC, id ASC`. The enqueue time is written only after the send succeeds, so an event that always fails does not hold the head of the queue.
- Terminal states are: success, parse failure, `CallFailedError`. A retryable error writes no completion mark. An R2 read error also counts as retryable.
- The migration backfill marks only events that the old query would no longer enqueue. The new pending set is a subset of the old candidate set.
  Each run may spend more than before, because the rotation now reaches events beyond the old `LIMIT 20`. The upper bound is "number of pending events × number of artifact types".
- Removing the score threshold for artifacts (round 6) increases calls. It is handled separately in #104: do it after the budget tiers are live, and the PR must state the expected extra daily spend.

## Adjustments to later waves

- **Sources** (the owner's words: "Finally, after all tasks are done, I need you to add more news data sources. You can refer to https://aihot.news/"):
  the round 6 rule "every section gets primary sources and independent reporting" merges into W6 (#90), after W5. aihot.news is a reference only. Do not use its name or logo.
  Every source must pass the onboarding red lines. Open a draft PR with a confirmation checklist, in the manner of #8.
- **Funding Round Tracker (#23) is redone in W4 with the D1 design of round 6.** The earlier v3 is kept in branch `wip/issue-23-v3`, and PR #74 is closed.
  The second version of contract #76 is void and closed. In W4, draft the third version from main again.

## Review process

- Before merging, there must be a record bound to the reviewed head. Merge with `--match-head-commit`. After a rebase, issue a new record based on the range-diff and on how the conflicts were resolved.
- The first reviewer is from a non-Anthropic family, in the order codex → agy → grok. When none of the three has quota, the first reviewer becomes fable and the second is an opus contract review. The record is marked [degraded]
  (this is what happened for #108, probe time 17:39Z).
- A fix that stays within the previous round's fix list is reviewed incrementally by ainews-design itself. No new review round is dispatched.
- A RED commit may fail typecheck because a new interface is missing, if the PR body says so. A test that proves the defect itself (defect witness) must be kept for the long term. Later changes only the way it is called.
- The mutation table in the PR body must separate two kinds: "run by the implementer personally" and "reported by an agent".

## Still to be done by the owner by hand (new in this round)

- Agree to change `content_display` of arXiv cs.AI to `full`. This is a one-line production write. It costs no money and can be reverted.

# Round 8 decisions (2026-10-26)

The W2 contract (#112) is finalized in this round. The owner's words: "Use autopilot, keep deciding and moving forward on your own, use unattended mode". The items below are all **decided by ainews-design on the owner's behalf**, with the same authority as round 6.
Money, switches, and production writes still need the owner's consent.

## Event versions and debounce (#112, PR #120)

- Public artifacts and claims take only one window: `(events.withdrawn_through, revision]`. A revision is written in three ways: grow, change, withdraw only.
  The detailed rules are in `architecture.md` section 6, "Event revision". The implementation is in #113.
- **Debounce**: it is due after 30 minutes of quiet since the last +1, or after 2 hours since the first +1, whichever comes first.
  This item replaces the round 6 rule "look only at `updated_at` being at least 30 minutes old": with quiet time alone, an event that someone keeps reviewing never becomes due.
- `<kind>_pending_since` is cleared only when the terminal mark of that kind is written. It is not cleared at enqueue. (This item replaces the "clear at enqueue" ruling of the third batch.)
- Accepted known behavior:
  - The same revision may be enqueued more than once. The generator must be idempotent for `(event, revision, kind)`. #113 adds a test for artifacts.
  - A review session longer than 2 hours triggers more than once, but at most once every 2 hours.
- **Auto-approval re-checks the section in SQL at commit time**: the condition is `publish_mode = 'auto'` and the slug is not `finance`.
  - The current code checks only when the analysis starts. If the admin moves the article to Finance during the analysis, the article is still auto-approved.
  - Production is not affected: all four sections are `review`. Fixed in #113.
- Body change: if either the old body or the new body has an approval record, treat it as a "change".
- An article that is in an event cannot change section (returns 409), so when a section changes there is no published version to take down. This satisfies the round 6 rule "take down at once on a section change".
- The analysis row that readers see is the row written in the approval record (`reviews.analysis_id`, read with `READER_ANALYSIS_ID_SQL`).
  - Every page that shows reader content uses it, including the claim review page.
  - `CANDIDATE_ANALYSIS_ID_SQL` is used only for the article review queue and for grouping.
  - This item completes the round 7 goal "until the new analysis is approved, readers still see the old approved version".
- A claim approved after the artifacts of R were generated does not enter any artifact. At R+1, evidence is extracted again, and the new claims must be reviewed again.

## Orphan recovery (#103)

- Option B is adopted: tighten the rule.
  - Orphan recovery of evidence uses `APPROVED_ARTICLE_SQL`. An orphan whose current body has no approval record is no longer attached back to an event. It must be reviewed again first.
  - Delete `ANY_BODY_APPROVED_SQL` and its entry in the allowlist. This item replaces the round 7 rule "whether to tighten it is decided in #103".

## Daily digest copy (#114, PR #119)

- The lead and the one-line comment of each item in the daily digest are model-written copy. The whole copy is made public only after the admin approves it (`digests.copy_approved_at`).
  Before approval, the public page and RSS show only the items themselves.
- Item titles come only from approved articles, not from stored titles: a stored title may come from an article whose approval was later revoked.
- The Finance daily digest can only be published manually.

## Still to be done by the owner by hand (updated in this round)

- `content_display` of arXiv cs.AI has been changed to `full` (the owner's words: "Agree to all", done at 2026-10-26T19:27:13Z, recorded in #86).
- Approve the copy of daily digests 9 and 13 in the admin area (do it after the post-deploy check of #114 is complete).

## Reader Ask (#133, demo period)

- A Reader Ask answer is a research result for the person who asked. It is not published content: it does not go into public pages, RSS, or the sitemap.
  - The answer is labeled "Model answer · not editor-reviewed", with one line below it, "Check it against the quoted sources below.".
  - It shows only the quotes that were checked verbatim against the approved body of this event. The rest are listed under "Could not verify".
  - On refusal, the model draft is not shown. No extra fetching is done. Finance is not open.
  - This is the only exception to "generated content is reviewed before publishing". The switch `ASK_PUBLIC_ENABLED` defaults to `"false"`.
