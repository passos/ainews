# Demo script (3 minutes)

The demo shows the loop in `docs/Newsren_Plan.md` §7 "Build three features
first": discover → understand → investigate → follow up. Site:
<https://news.ioenv.com>. Admin pages need a Cloudflare Access login; log in
before the demo.

## Path

| Time | Page | What to show | Plan reference |
| ---- | ---- | ------------ | -------------- |
| 0:00–0:15 | `/` | Four sections in the navigation. Every card is an approved story with its source. | N§5, Stage 1 |
| 0:15–0:50 | `/e/98` | AI Story Brief: What happened, What is new, What evidence exists, What to watch next. Source article with published and fetched times. Evidence labels (`preprint`, `fact`). | N§2.2, N§2.5, N§6 |
| 0:50–1:20 | `/e/98`, "Explain for" | Switch Student → Educator → Professional. Show the glossary and the discussion prompt in News-to-Learning. | N§2.3, N§5 |
| 1:20–1:35 | `/e/98`, Research Paper Decoder | Hypothesis, method, findings, limitations, applications. "Not specified in available text" shows the agent does not invent. | N§3 Technology |
| 1:35–1:50 | `/e/117` | Timeline: one story built from two reports. | N§2.2 Connected stories |
| 1:50–2:15 | `/e/120`, `/e/155`, `/e/173` | Four sections: same pipeline, section-specific editorial products. Education: Evidence Checker ("39 meta-analyses, 39 positive findings"). Finance: Regulation Watch on the SEC FY2027 exam priorities, with the "Not investment advice" notice. Industry: Supply-Chain Ripple Map on the UPS rate increase. | N§3 |
| 2:15–2:30 | `/admin/ask` | Ask a question about an event. The answer cites only approved source text and says what it could not verify. | N§1 reader loop, Stage 2 |
| 2:30–2:50 | `/w`, then `/w/ai-startups` | Follow a Topic: a saved question with criteria. One published hit on `/e/177` "Anthropic officially files for its public debut" (TechCrunch, 2 cited articles). The watch fires only on articles approved after it was created, and its criteria reject commentary. | N§2.6, Stage 3 |
| 2:50–3:00 | `/s/finance` | Finance notice: informational, not investment advice. Then `/admin/ledger`: every model call has a cost and is reserved against a daily budget cap before it is sent. | N§4 guardrails, N§9 Cost |

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
for p in / /s/technology /s/education /s/industry /s/finance /e/98 /e/117 \
  /e/120 /e/147 /e/155 /e/173 /e/177 /w /w/ai-startups \
  /digest/technology/2026-10-26; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://news.ioenv.com$p"
done
```

Every line must print 200. Then open `/admin/ask` and `/admin/watches` in the
browser to confirm the Access login is still valid.
