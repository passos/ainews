# Demo script (3 minutes)

The demo shows the loop in `docs/Newsren_Plan.md` §7 "Build three features
first": discover → understand → investigate → follow up. Site:
<https://news.ioenv.com>. Admin pages need a Cloudflare Access login; log in
before the demo.

## Path

| Time | Page | What to show | Plan reference |
| ---- | ---- | ------------ | -------------- |
| 0:00–0:20 | `/` | Four sections in the navigation. Every card is an approved story with its source. | N§5, Stage 1 |
| 0:20–1:00 | `/e/98` | AI Story Brief: What happened, What is new, What evidence exists, What to watch next. Source article with published and fetched times. Evidence labels (`preprint`, `fact`). | N§2.2, N§2.5, N§6 |
| 1:00–1:30 | `/e/98`, "Explain for" | Switch Student → Educator → Professional. Show the glossary and the discussion prompt in News-to-Learning. | N§2.3, N§5 |
| 1:30–1:50 | `/e/98`, Research Paper Decoder | Hypothesis, method, findings, limitations, applications. "Not specified in available text" shows the agent does not invent. | N§3 Technology |
| 1:50–2:05 | `/e/117` | Timeline: one story built from two reports. | N§2.2 Connected stories |
| 2:05–2:30 | `/admin/ask` | Ask a question about an event. The answer cites only approved source text and says what it could not verify. | N§1 reader loop, Stage 2 |
| 2:30–2:50 | `/w`, then one watch | Follow a Topic: a saved question and the hits that met its criteria, with a private RSS feed. | N§2.6, Stage 3 |
| 2:50–3:00 | `/s/finance` | Finance notice: informational, not investment advice. Then `/admin/ledger`: every model call has a cost, under a $2/day cap. | N§4 guardrails, N§9 Cost |

Backup pages if one fails: `/digest/technology/2026-10-26` (daily briefing),
`/s/education`, `/s/industry`.

## Talking points

- Every generated item keeps its sources, publication time and retrieval time
  (N§6).
- A human editor approves every story before it is public. Finance is always
  reviewed (N§4, N§6).
- The model never sees the public site code: public pages read only approved
  data.

## Pre-flight (30 minutes before)

```sh
for p in / /s/technology /s/education /s/industry /s/finance /e/98 /e/117 /w \
  /digest/technology/2026-10-26; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://news.ioenv.com$p"
done
```

Every line must print 200. Then open `/admin/ask` and `/admin/watches` in the
browser to confirm the Access login is still valid.
