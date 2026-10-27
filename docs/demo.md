# Demo script (3 minutes)

The demo shows the loop in `docs/plan/Newsren_Plan.md` §7 "Build three features
first": discover → understand → investigate → follow up. Site:
<https://news.ioenv.com>. Admin pages need a Cloudflare Access login; log in
before the demo.

Open these tabs in order before you start: `/`, `/e/98`, `/e/117`, `/e/120`,
`/e/155`, `/e/173`, `/w/ai-startups`, `/follow`, `/admin/published`,
`/admin/ledger`.

## Path

| Time | Page | What to do | Plan |
| ---- | ---- | ---------- | ---- |
| 0:00–0:15 | `/` | Point at the four sections in the navigation and at one story with its source and times. | N§5, Stage 1 |
| 0:15–0:45 | `/e/98` | Scroll through **Story brief**: What happened, What is new, What evidence exists, What to watch next. Then **Evidence**: one claim and its verbatim quote with the "model assessment" label. | N§2.2, N§2.5, N§6 |
| 0:45–1:05 | `/e/98` | **Explain**: click student → educator → professional. Then **Paper decoder**: point at "Not specified in available text". | N§2.3, N§3 Technology |
| 1:05–1:20 | `/e/117` | **Timeline**: "First report", then "New report" and what each one added. | N§2.2 |
| 1:20–1:40 | `/e/120`, `/e/155`, `/e/173` | One product per section. Education: **Education evidence** on 14 meta-analyses. Finance: **Regulation watch** on the SEC FY2027 exam priorities and the "not investment advice" notice. Industry: **Supply chain** on the UPS 5.9% rate increase. | N§3, N§4 |
| 1:40–2:05 | `/e/98` | **Ask about this story**: type the question below and submit. Talk over the wait (about 15 seconds). Point at "Model answer · not editor-reviewed" and the verified quotes. | N§2.1, Stage 2 |
| 2:05–2:30 | `/w/ai-startups`, then `/follow` | The watch question and its criteria. One hit: Anthropic files for its IPO (`/e/177`). On `/follow`, show that a reader can create a private watch. | N§2.6, Stage 3 |
| 2:30–2:50 | `/admin/published`, `/admin/ledger` | An editor approves every story and can remove one. The ledger shows every model call and its cost against the daily cap. | N§6, N§9 |
| 2:50–3:00 | `/` | Close. | — |

Question for Ask (tested on production):

> What dataset or benchmark did the paper use to evaluate its method?

If the Ask card fails, open `/admin/ask` and show the answered question there.
If `/admin/published` is not deployed yet, use `/admin/review`.

## Narration

**0:00 — Home.**
"This is Daily, an agentic news site. It covers four sections: Technology,
Education, Industry and Finance. Every story you see was approved by an
editor, and every one shows its source, when it was published and when we
retrieved it."

**0:15 — Story brief.**
"When several reports cover the same story, the agent groups them into one
event and writes a Story Brief: what happened, what is new, what evidence
exists, and what to watch next. Below it, the Evidence section lists the
claims. Each claim links to a verbatim quote, and code checks that the quote
really is in the source text. Model judgements are labelled as model
assessments."

**0:45 — Explain.**
"The same story, explained for a student, an educator and a professional.
This is a research paper, so the agent also decodes it: hypothesis, method,
findings, limitations. Where the paper does not say something, it writes
'not specified in available text'. It does not invent."

**1:05 — Timeline.**
"Stories develop. Here the first report came from MIT Technology Review, and
later reports added the underlying paper. The timeline shows what each report
added."

**1:20 — Sections.**
"The same pipeline produces products for each section. In Education, an
evidence checker on a critique of 14 meta-analyses. In Finance, a regulation
watch on the SEC's exam priorities, with a not-investment-advice notice on
every page. In Industry, a supply-chain ripple map for a UPS rate increase."

**1:40 — Ask.**
"Readers can ask about a story. I will ask what benchmark the paper used.
While it runs: the agent searches only the approved articles of this story,
answers with quotes, and then code checks each quote against the source. The
answer is labelled as a model answer that no editor has reviewed. Here are
the verified quotes."

**2:05 — Follow.**
"Follow a Topic. This watch asks to be told when an AI startup ships a
product or reaches a documented milestone. Commentary does not count. It
fired once: Anthropic filed for its IPO. Readers can create their own private
watch here, delivered by RSS."

**2:30 — Editor and cost.**
"Behind the site, an editor approves every story and can remove any of them.
Every model call goes through one client: it is recorded in this ledger with
its cost, and it is reserved against a daily budget before it is sent."

**2:50 — Close.**
"Discover, understand, investigate, follow up, with every claim traced to its
source. Thank you."

## Talking points for questions

- Fixed steps are code. Jev makes fast structured judgements; Gemini writes
  and reasons. Public pages cannot import model code; a test enforces it.
- Finance is always reviewed by a human (N§4).
- Every generated item is tied to the version of the event it was built
  from, so an old job cannot overwrite a newer result.
- Total model spend so far is about $7 for about 3,600 calls.

## Pre-flight (30 minutes before)

```sh
for p in / /s/technology /s/education /s/industry /s/finance /e/98 /e/117 \
  /e/120 /e/155 /e/173 /e/177 /w /follow /w/ai-startups \
  /digest/technology/2026-10-26; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://news.ioenv.com$p"
done
```

Every line must print 200. Then open `/admin/published`, `/admin/ask` and
`/admin/ledger` in the browser to confirm the Access login is still valid.

The Ask card makes a real model call for each question (about $0.0014 each)
and counts against a global limit of 30 public questions per day. Ask once in
rehearsal at most.

Backup pages if one fails: `/digest/technology/2026-10-26` (daily briefing),
`/s/education`, `/s/industry`.
