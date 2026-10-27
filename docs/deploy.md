# Deployment and launch evidence procedure

Status: **Verified (code)**: baseline `cab0433` uses main → ci → deploy. It runs the remote migration first, then builds and deploys. It does not seed automatically. **Unknown**: the current production version, flags, the actual Gateway cost/limit, Analytics, the 24h history, and the M1–M4 acceptance. This procedure is not run evidence. #23 funding and #24 metrics/feedback are not in this baseline. The final contract (including #75) and independent acceptance are still hard gates for merge and launch. Writing a local draft first does not exempt them.

## Operation classes and approval sheet

Replace every `/ABS/WORKTREE`, `/ABS/SCRATCH` and `/ABS/EVIDENCE` with the absolute path of this run's own worktree and private evidence directory. The commands have not been run. Each approval names the environment, SHA/version, resources, impact, cost cap, recovery point/rollback, owner, and UTC window. Every online read-only check (GET/SELECT/audit) must state in the approval sheet who authorized it and on which day. If the approval sheet has no authorizer and date, do not run the check. The existing project boundaries stay as they are: flags, paid models/Jina, production writes, source list/thresholds and public UI screenshots all need explicit approval. Without approval, do only local-only work.

| Class            | Permission and impact                                                                                                                  | Evidence scope                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| local-only       | No production credentials; do not copy `.env*`/`.dev.vars*`, do not inherit production credentials; Node 24, locked dependencies installed | exit codes, test counts, bundle size                                            |
| remote-read-only | Authorized reader (name the authorizer and date in the approval sheet each time); a GET/query also has access and request cost         | SHA, job conclusion, version, schema object counts, aggregate numbers, fixed error codes |
| owner-mutation   | Run once, after one specific approval; no implicit retry                                                                                | counts before and after, the named version, secret names/dates; on failure, check the actual state first |

The owner supplies credentials in a controlled session. Never write them into commands, temp files or reports. Never load `.env.prod` automatically. Tracing is forbidden. Output of environment, headers, raw errors, requests, responses, prompts, bodies, IPs, JWTs and cookies is forbidden. Do not download deployment payload logs. Do not publish a full binding dump. Redact private originals first. A public report keeps only the fields in the table above.

## Local-only: rehearsal and gate

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler types --check)
npm --prefix /ABS/WORKTREE run typecheck
npm --prefix /ABS/WORKTREE run lint
npm --prefix /ABS/WORKTREE test
(cd /ABS/WORKTREE && CLOUDFLARE_ENV=test npm run build)
npm --prefix /ABS/WORKTREE run test:ssr
node /ABS/WORKTREE/scripts/smoke.ts --base-url https://news.ioenv.com --mode routes --dry-run
```

The build with `CLOUDFLARE_ENV=test` and `test:ssr` make `/ABS/WORKTREE/.wrangler/deploy/config.json` redirect to the generated test config `dist/server/wrangler.json` (name `ainews-app-test`, placeholder D1 id, all five safety switches false). This is only local state. It is not evidence of a wrong deployment. But Wrangler commands that follow this redirect by default will keep using it (checked in the installed source: deploy, versions upload; version `4.152.0`, obtained on 2026-10-26 with `npx --no-install wrangler --version` in `/Users/simon/workspace/cmu/ainews-launch-25`, and it matches `node_modules/wrangler` in `package-lock.json` of that directory). So before a production rehearsal or deployment, you must redo the production build and check the generated config. See the next section. I checked that `d1 execute` and `d1 migrations list` of the same version do not enable the redirect. Still, always pass `--config` explicitly for every remote operation.

## Target config check (before rehearsal and deployment)

```sh
(cd /ABS/WORKTREE && rm -rf dist .wrangler/deploy && env -u CLOUDFLARE_ENV npm run build)
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const f=["COLLECT_ENABLED","MODEL_CALLS_ENABLED","THIRD_PARTY_READER_ENABLED","EMAIL_ENABLED","DISCOVERY_ENABLED"];console.log(JSON.stringify({name:c.name,d1:(c.d1_databases||[]).map(d=>[d.binding,d.database_name,d.database_id]),flags:Object.fromEntries(f.map(k=>[k,(c.vars||{})[k]]))}))' /ABS/WORKTREE/dist/server/wrangler.json
(cd /ABS/WORKTREE && CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy --dry-run --config /ABS/WORKTREE/dist/server/wrangler.json --outdir /ABS/SCRATCH/deploy-dry-run)
```

Clean only `dist` and `.wrangler/deploy` in your own worktree. Check the output: `name` is `ainews-app` (not `ainews-app-test`); the D1 binding/name/id match `/ABS/WORKTREE/wrangler.jsonc` and are not the `00000000` placeholder; the five flags match the top-level `vars` in `wrangler.jsonc` exactly (not the all-false test values). If any item does not match, stop. Do not deploy. A Vite deployment uses the framework-generated `dist/server/wrangler.json`. Do not force it to use the root `wrangler.jsonc` (that file points to the source entry and bypasses the framework build output).

The rehearsal only compiles. It does not upload. A production build that passes the check also does not prove that the production bindings/routes/limits are correct. The bundle may contain non-secret vars, so do not publish the whole config. The smoke default / `--dry-run` makes zero network calls and gives `executed=false`; exit 0 means only that the plan is valid. `backfill --dry-run` still requests pages. A model probe goes out to the network and may cost money. SSR uses isolated local fixtures. Do not treat them as the same safety level.

## Owner-mutation: first deployment and updates

By default, use the existing CI: the PR passes all gates, guard-removal mutations and two independent reviews (one from a different family), and all owner items pass. Then squash, with the review bound to the final head. Check that ci and deploy both succeed for the same main SHA. `gh run view APPROVED_RUN_ID --repo githonllc/ainews --json headSha,conclusion,jobs` is for an authorized read-only check of the conclusion only. Do not download logs. Never cancel a job during a migration. A success does not mean the business gates pass.

For the first provision, use the existing script to create D1, R2, queues and Vectorize. Review the resources and cost first: `bash /ABS/WORKTREE/scripts/provision.sh`. A routine update does not provision, seed, backfill or replay. A migration must be incremental. It must not rebuild a referenced table. If it is incompatible, stop first.
Deploy by hand only when CI is unavailable and the owner explicitly approves. First record the fallback version, the D1 recovery point and the migration list. Confirm that no `CLOUDFLARE_ENV=test` is left over. Clean only the build artifacts in your own worktree. Then use the production config:

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler d1 migrations apply DB --remote --config /ABS/WORKTREE/wrangler.jsonc)
(cd /ABS/WORKTREE && rm -rf dist .wrangler/deploy && env -u CLOUDFLARE_ENV npm run build)
# Check dist/server/wrangler.json as in the previous section, then deploy:
(cd /ABS/WORKTREE && npx --no-install wrangler deploy --config /ABS/WORKTREE/dist/server/wrangler.json)
```

Keep the existing five safety switches. To change a switch, open a separate switch-only PR with owner approval. After a failure, first check the actual deployment/schema state. Never rerun blindly. For source onboarding, follow the [source procedure](source-onboarding.md) separately.

## Remote-read-only: authorized audit

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler d1 migrations list DB --remote --config /ABS/WORKTREE/wrangler.jsonc)
(cd /ABS/WORKTREE && npx --no-install wrangler deployments list --name ainews-app --config /ABS/WORKTREE/wrangler.jsonc --json)
(cd /ABS/WORKTREE && npx --no-install wrangler secret list --name ainews-app --config /ABS/WORKTREE/wrangler.jsonc --format json)
```

Filter the output on the controlled side: strip personal fields such as the author from the version; for secrets keep only the name and date (this does not prove the value is correct). Read the five live flags only from the owner-approved control plane: the five names and values. Do not download the Worker bundle, because it may carry secrets. Check the Gateway limit/credits/channel one by one in the official control plane. If you have no permission, record unknown. Do not probe with a paid call.
The reader runs each query below as one SELECT at a time, passed with `--command`. The SQL may come from an approved absolute-path file, but you must read it into a string and pass the string. **Do not use `--file`** (Q3 and Q5 hold several statements; split them into separate files and run them one by one).

**You must run the precheck first** (for every SQL file and before every execution; never skip it). After you remove the `--` comment lines and the blank lines, the file may have only one semicolon, at the end. The first line must start with `SELECT`. The file must not contain keywords that write, change the schema, or start a transaction. If the output is not `PRECHECK_OK`, stop. Do not run the next command:

```sh
SQL_FILE=/ABS/EVIDENCE/audit-q1.sql
body=$(grep -v '^[[:space:]]*--' "$SQL_FILE" | grep -v '^[[:space:]]*$')
semis=$(printf '%s\n' "$body" | tr -cd ';' | wc -c | tr -d ' ')
if [ "$semis" = 1 ] \
  && printf '%s\n' "$body" | tail -n 1 | grep -qE ';[[:space:]]*$' \
  && printf '%s\n' "$body" | head -n 1 | grep -qiE '^[[:space:]]*SELECT([[:space:]]|$)' \
  && ! printf '%s\n' "$body" | grep -qiwE 'INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT'
then echo PRECHECK_OK; else echo PRECHECK_FAIL; fi
```

After the precheck passes, run the same file in the same shell:

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler d1 execute DB --remote --json --config /ABS/WORKTREE/wrangler.jsonc --command "$(cat "$SQL_FILE")")
```

A remote `--file` goes through bulk import. It returns only the summary `Total queries executed/Rows read/Rows written/Database size` (**assumption, evidence still to be added**: observed only in a temp file on one machine, and the original did not enter an issue; the [audit comment on #26](https://github.com/githonllc/ainews/issues/26#issuecomment-6411383128) records only that the read-only query gave success=true and rows_written=0, which cannot prove the return shape of `--file`). That summary is not query evidence. Only `--command` returns the query columns (also an **assumption, evidence still to be added**). SELECT only. No automatic repair/reconcile. Do not call admin POST endpoints:

```sql
-- Q1: exact current-body review; seed is not production evidence.
SELECT i.slug,i.publish_mode,i.primary_domains,i.config_version,
 (SELECT COUNT(*) FROM sources s WHERE s.industry_id=i.id AND s.status='active') AS active_sources,
 (SELECT COUNT(*) FROM articles a WHERE a.industry_id=i.id) AS articles,
 (SELECT COUNT(*) FROM articles a JOIN reviews r ON r.article_id=a.id AND r.body_sha=a.body_sha
  WHERE a.industry_id=i.id AND r.decision='approved' AND r.reviewer<>'auto') AS current_manual_approved,
 (SELECT COUNT(*) FROM articles a JOIN reviews r ON r.article_id=a.id AND r.body_sha=a.body_sha
  WHERE a.industry_id=i.id AND r.decision='approved' AND r.reviewer='auto') AS current_auto_approved
FROM industries i ORDER BY i.id;
-- Q2: latest state cannot prove an uninterrupted 24h window.
SELECT s.id,i.slug,s.kind,s.status,s.interval_minutes,s.fail_count,s.last_ok_at,s.last_failed_at,s.next_fetch_at,s.jina_enabled
FROM sources s JOIN industries i ON i.id=s.industry_id ORDER BY s.id;
-- Q3: only named nonsecret settings; existing daily cap is preserved.
SELECT key,value FROM settings WHERE key IN ('budget.caps','models.slots','models.prices') ORDER BY key;
SELECT day,channel,cap_micros,reserved_micros,spent_micros FROM budgets
WHERE day>=date('now','-1 day') ORDER BY day,channel;
-- Q4: reservation UTC day, not completion date; include all statuses.
SELECT budget_day,channel,slot,model,status,COUNT(*) AS n,SUM(COALESCE(cost_micros,0)) AS settled_micros,
 SUM(CASE WHEN status IN ('in_flight','unknown') THEN COALESCE(estimated_micros,0) ELSE 0 END) AS unresolved_reserved_micros
FROM llm_calls WHERE budget_day>=date('now','-1 day')
GROUP BY budget_day,channel,slot,model,status ORDER BY budget_day,channel,slot,status;
-- Q5: conservative alarms, never export raw errors or payloads.
SELECT COUNT(*) AS unknown_calls FROM llm_calls WHERE status='unknown';
SELECT COUNT(*) AS last_hour_failed FROM llm_calls WHERE status='failed'
 AND updated_at>=CAST(strftime('%s','now') AS INTEGER)*1000-3600000;
SELECT COALESCE(SUM(COALESCE(cost_micros,estimated_micros,0)),0) AS gateway_hour_micros
FROM llm_calls WHERE channel='gateway' AND sent_at IS NOT NULL
 AND sent_at>=CAST(strftime('%s','now') AS INTEGER)*1000-3600000;
-- Q6: candidate manifest only; publication may filter withdrawn inputs.
SELECT i.slug,d.id,d.kind,d.period_start,d.status,d.published_at,json_array_length(d.items_json) AS stored_items
FROM digests d JOIN industries i ON i.id=d.industry_id WHERE d.status='ready' AND d.published_at IS NOT NULL
ORDER BY d.published_at DESC LIMIT 20;
-- Q7: check each new migration object separately with exact schema/PRAGMA.
SELECT name,type FROM sqlite_master WHERE type IN ('table','index')
 AND name IN ('industries','sources','articles','reviews','digests','llm_calls','budgets','filings','financial_facts') ORDER BY type,name;
```

Evidence validation: the exit code is 0; stdout is a parseable JSON array (if there is a progress prefix, record it as an anomaly, and strip it only after you keep the original and note it); every element has `success===true` and `results` is an array; the column names of `results[0]` equal the expected columns in the table below. A missing column or an extra summary column means the output is not evidence for that query. For a zero-row result, record only "zero rows, columns not validated". Do not fill in 0 automatically.

| Query | Expected columns                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| Q1    | slug, publish_mode, primary_domains, config_version, active_sources, articles, current_manual_approved, current_auto_approved     |
| Q2    | id, slug, kind, status, interval_minutes, fail_count, last_ok_at, last_failed_at, next_fetch_at, jina_enabled                     |
| Q3    | key, value; day, channel, cap_micros, reserved_micros, spent_micros                                                               |
| Q4    | budget_day, channel, slot, model, status, n, settled_micros, unresolved_reserved_micros                                           |
| Q5    | unknown_calls; last_hour_failed; gateway_hour_micros                                                                              |
| Q6    | slug, id, kind, period_start, status, published_at, stored_items                                                                  |
| Q7    | name, type                                                                                                                        |

Q1/Q2 do not export feed URLs. On the private side, match row by row against the approved dossier. The report keeps only the source id, approval reference and status. `stored_items>0` does not prove the digest is still public. `approvedArticleWhere` requires the current body_sha. Grouped does not equal approved. #25 adds no new migration objects.

## Remote-read-only: smoke routes / launch

Every online read-only GET must state in the approval sheet who authorized it and on which day. Check the actual value of the example Access origin first. Use anonymous GET only. Refuse to follow redirects. Send no credentials. Do not call server functions/Ask/feedback. Do not visit external articles/SEC. Do not explore links automatically or repair empty content.

```sh
node /ABS/WORKTREE/scripts/smoke.ts --base-url https://news.ioenv.com --mode routes --access-origin https://ioenv.cloudflareaccess.com --online
node /ABS/WORKTREE/scripts/smoke.ts --base-url https://news.ioenv.com --mode launch --manifest /ABS/EVIDENCE/public-smoke-manifest.json --access-origin https://ioenv.cloudflareaccess.com --online
```

The manifest holds only these keys: `eventIds`, an array of positive safe integers; `watchSlugs`, an array of lowercase alphanumeric-and-hyphen strings; `digests`, an array (section is one of the four slugs, a real YYYY-MM-DD date, kind daily/weekly); `funding`, a boolean (default false). Arrays are empty by default. Duplicate paths are de-duplicated. Extra keys are rejected. The owner picks values from real public records. The observation UTC time and the selection basis go into an adjacent private evidence sheet. Fixture IDs/dates are forbidden. The date need not be today. No arbitrary URLs. The manifest path must be absolute.
`routes` can check an empty RSS, but it prints `contentReadiness=unchecked`. `launch` requires non-empty RSS for all four sections, at least event/watch/Technology daily/any weekly/funding, at least 1 item on every digest page, and at least 1 hit on every watch page (otherwise `EMPTY_DIGEST`/`EMPTY_WATCH`). Funding fails while #23 is not merged. #24 is admin evidence, so do not invent a public URL. A failed or incomplete run exits 1. Invalid arguments exit 2. A dry-run exit 0 does not mean the requests passed. `contentReadiness=checked` means only that this launch run's coverage passed. It cannot replace M1–M4. Each request has 10s including the stream, 120s overall, concurrency 2, 64 cases, 2MiB read per body, and no retry. Normal pages must return exactly 200 and missing pages exactly 404. For admin, accept only 401/403, or a 302/303/307 to the specified HTTPS Access origin. A 200 login shell fails. This proves only that anonymous users cannot read. It does not prove the admin list or server function auth.

## M1 financial: three-way reconciliation

Fix the UTC half-open interval `[start,end)`, the SHA, the Gateway id and the pricing version. Save Q3/Q4. Check the settings cap, the current-day budgets cap and the effective Gateway limit separately. Do not treat the default daily $2 as the real limit.
From the application pipeline, select the rows of real generateText write/reason calls that are completed and have a non-empty sent_at. On the private side, check the Gateway request/log metadata and the actual billing. Export only id, slot/model/channel, sent_at, budget_day, input/output_tokens, cost_micros and attempt.
Add up the settled sent calls by the same budget_day/channel, including failed calls that carry a cost. Compare the sum with spent. List in_flight/unknown reservations separately. Across midnight, use the reservation day. Explain duplicate attempts, estimate fallback, late logs, unknown calls, and differences from non-application requests / channels. Never write to the DB to force the difference to zero.

Residual definition: `residual = budgetBooked − the signed value recorded in the ledger`. `budgetBooked` means the spent that `budgets` booked. It is only the difference between two recorded values. It is not an allocation to entities. It is not proof of an invoice. Do not use the current `cost_micros`/`estimated_micros` to rebuild the amount of an old attempt that was overwritten. `unknown=0` also does not prove that the old amount was 0. Historically, root observed on 2026-10-24 that gateway booking was higher by +37,835 micro-dollars, and the cause is unknown (it only turned out equal in value to the sum of the current estimates of 32 rows with attempt>1. This is not 32 verified charges. Source: [section "Production aggregate evidence increment" in the body of #24](https://github.com/githonllc/ainews/issues/24), gateway 2026-10-24 `signed_residual: 37835`, `rows_attempt_gt1: 32`, `sum_current_estimated_for_retried_rows: 37835`). The days after that prove only that the recorded values match. Do not infer from them that Oct24 was reconciled. The report must not print production PII or raw secrets. Historical confirmation of Jev does not prove the embed channel. Do not book by the `@cf/` prefix. If the Gateway eventual-consistency window is not closed, or the cost / permission / limit / credits are missing, record unknown and re-check around the window. M1 requires real application generateText completed rows, positive spent for the day, and a matching actual cost. A binding probe and a D1 estimate are not enough.

## 24h, stop conditions, rollback

recordSuccess overwrites last_ok_at. The date span of articles, one snapshot, and a CI success do not prove continuous collection. Root first checks the metadata of existing successes / schedules / HTTP results. Do not export payloads. If the history is not enough, the owner schedules a follow-up observation of the two named Technology sources for more than 24h at their own cadence. It covers every round, including 304 and empty rounds, with start, end and gaps. Hourly snapshots are only auxiliary. Do not make up history. Do not change cron. A persistent audit is a separate scope.
Any stop condition: Gateway above 500,000 micros ($0.50) in one hour, the same kind of error keeps growing, or any unknown call. Q5 includes estimates and serves only as a conservative alarm. Check the actual Gateway separately. There is no new threshold for error counts. On the controlled side, map only to fixed categories / counts. Stop scale-up and model probes at once. Report to root. Prepare a separate emergency PR that changes only `MODEL_CALLS_ENABLED` to `"false"` and keeps COLLECT_ENABLED on. This PR still needs owner consent / review / deploy. Do not change the flag directly with the CLI. Do not automatically resend / reconcile / clear reservations. Do not cancel in-flight calls. Keep watching for late settlement. To restore, you need another owner-approved flag-only PR.
A rollback rehearsal is remote-read-only: pick the current version and the previous verified version. Review schema compatibility, vars/five safety switches, secret versions, cron/queues, bindings and migrations. A rollback dry-run does not exist. If the old version would reopen a flag, use a revoked secret or an incompatible schema, do not roll back directly. The recommendation is a known-good forward-fix PR that keeps the current safe config.
Run the following only after the owner approves the exact version:

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler rollback APPROVED_VERSION_ID --name ainews-app --config /ABS/WORKTREE/wrangler.jsonc --message "Owner-approved incident rollback")
```

Never omit the version and let the CLI guess. A Worker rollback does not restore D1/R2. To restore data, review the recovery point, the write freeze and the loss window separately. DROP, down migrations and overwriting bodies are forbidden. After a rollback, check the active version, schema, flags and an authorized smoke through independent channels. Fix main so that the next deployment does not overwrite the rollback.

## Owner-mutation: rotation, one item at a time

There is no zero-risk secret dry-run. An approval selects only one item. Register the name / purpose / owner / least privilege / custodian / revocation date. Do not collect values. secret list shows names only and does not prove function.

| Object                                                  | Precheck, post-approval action and independent verification                                                                                                                                                                                                                                                       | Rollback / impact                                                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub CLOUDFLARE_API_TOKEN                             | Create a least-privilege token in the official console and update it in a secure UI. Verify it with the next approved deploy/job and the active version. Then revoke the old one                                                                                                                                  | Do not deploy extra just to verify the token. On failure, fall back to the old secret, which is still valid                                                          |
| Worker JINA_API_KEY and the AI secrets actually needed  | First check what the feature really uses. After approval: `(cd /ABS/WORKTREE && npx --no-install wrangler secret put APPROVED_SECRET_NAME --name ainews-app --config /ABS/WORKTREE/wrangler.jsonc)` with private interactive input. Check the version/name and observe the approved feature                         | put may create a version / deploy. If the feature is off, leave it unknown. Do not turn it on or use a paid probe to verify the key. Keep the old key in a normal window. On a leak, revoke the old key at once |
| FEEDBACK_SALT (future #24)                              | First confirm the merge and the unique key / UTC day boundary. Rotate in private. Verify with the #24 local fixtures / existing monitoring. Do not use smoke votes                                                                                                                                                | Recommended: the UTC day boundary. Changing the salt within a day allows repeat votes. In an emergency, accept the impact. After a leak, never reuse the old salt. Do not change history |
| Access AUD/team-domain vars                             | A dedicated config PR. Keep the owner's control-plane channel. Check real login and anonymous rejection separately                                                                                                                                                                                                | Prevents lockout. This is not a secret put. Do not export a JWT/cookie                                                                                               |
| CF_BEACON_TOKEN public var                              | Keep the current empty-token policy; Engagement is unknown. Enabling it needs an owner decision and a config review. Verify with the public HTML and the official Analytics                                                                                                                                       | Do not create a site or fill in the token for the owner. To withdraw, use a dedicated PR to set it empty                                                             |

## Evidence handover and #26 gate

Each cell stores the UTC time, environment, SHA/version, command/observation, path of the redacted original, owner sign-off, and a four-state conclusion (verified / inferred / assumed / unknown). If the original is missing, always mark unknown. Production snapshots such as 805/93 are outside the scope of local re-verification. Do not cite them as live state.

| Gate                  | Operational evidence to add (local code/CI cannot replace it)                                                                                                                                                                                                                                                    | Current                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| M0                    | The owner's historical acceptance, current anonymous rejection and version                                                                                                                                                                                                                                       | Unknown (not re-verified in this unit)   |
| M1 collection/editing | Both named sources >24h, round by round; a real Technology digest, with manual review of the current body of all its inputs; the admin email checked separately for identity / delivery                                                                                                                            | Unknown                                  |
| M1 cost               | The application generateText / positive spent / actual Gateway cost reconciliation above, plus limit/credits/embed channel                                                                                                                                                                                        | Unknown                                  |
| M2                    | For a real event, the article/body_sha/quote/offset of every claim can be located; the authorized admin Ask refuses questions with no answer; a real model needs its own approved budget report                                                                                                                  | Unknown                                  |
| M3                    | Real substantive progress hits only once, and it is idempotent for the same revision; no data is made up when there is no new progress                                                                                                                                                                            | Unknown                                  |
| M4                    | Each of the four sections has an active real source / a successful fetch in the current period / current manually approved content, and a public section/RSS; for every earnings reported / prior-period / prior-year / derived value, the filing unit period/accession and the formula inputs; Finance review/notice; final independent sign-off on #23/#24 | Unknown                                  |
| #25 code / launch     | Local gate / mutations / two reviews on the final head; plus an approved source, the owner's real manifest, an authorized launch and the operations handover                                                                                                                                                      | This document does not sign it as passed |

The owner must still decide: the new source / Industry domains and the activation channel, the thresholds (reuse is recommended), Gateway read permission, the 24h window, Email Service / sender identity, Analytics (recommended: keep it empty), the rotation window, and the final integration of #23/#24. Each item blocks only its own action. Root asks to close #26 only after all the originals are signed off. An all-green smoke cannot close the epic.
