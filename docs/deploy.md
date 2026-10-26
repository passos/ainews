# 部署与上线证据规程

状态：**已验证（代码）**：基线 `cab0433` 使用 main → ci → deploy；先远端迁移再构建部署，不自动 seed。**未知**：当前生产版本、flags、Gateway实际费用/limit、Analytics、24h历史和 M1–M4 验收。本规程不是运行证据。#23 funding、#24 metrics/feedback 不在该基线；最终契约（含 #75）与独立验收仍是硬合并/上线门槛，允许先写本地草稿不构成豁免。

## 操作分级与审批单

所有 `/ABS/WORKTREE`、`/ABS/SCRATCH`、`/ABS/EVIDENCE` 必须替换为本次独立工作树和私有证据目录的绝对路径。命令未执行。每份审批点名 environment、SHA/version、资源、影响、费用上限、恢复点/回退、owner、UTC窗口。每次线上只读检查（GET/SELECT/审计）都要在审批单里写明是谁、哪天授权的；审批单没写授权人和日期就不执行；flags、付费模型/Jina、生产写、信源名单/阈值、公开UI截图等既有项目明确批准边界不变，未获批准的只做 local-only。

| 类别 | 权限与影响 | 证据范围 |
|---|---|---|
| local-only | 无生产凭证；不复制 `.env*`/`.dev.vars*`，不继承生产凭证；Node 24、已安装锁定依赖 | exit、测试计数、bundle大小 |
| remote-read-only | 已授权reader（每次在审批单写明授权人和日期）；GET/查询也有访问和请求成本 | SHA、job结论、version、schema对象计数、聚合数值、固定错误码 |
| owner-mutation | 单项具体批准后执行一次；不隐式重试 | 前后计数、指定版本、secret名称/日期；失败先核实际状态 |

凭证由owner在受控会话提供，不写入命令、临时文件或报告，不自动加载 `.env.prod`。禁止 tracing、环境/headers/raw error/request/response/prompt/body/IP/JWT/cookie 输出；不下载部署payload日志，不公开完整binding dump。私有原件先脱敏，公开报告仅保留上表字段。

## Local-only：预演与 gate

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler types --check)
npm --prefix /ABS/WORKTREE run typecheck
npm --prefix /ABS/WORKTREE run lint
npm --prefix /ABS/WORKTREE test
(cd /ABS/WORKTREE && CLOUDFLARE_ENV=test npm run build)
npm --prefix /ABS/WORKTREE run test:ssr
node /ABS/WORKTREE/scripts/smoke.ts --base-url https://news.ioenv.com --mode routes --dry-run
```

`CLOUDFLARE_ENV=test` 的构建和 `test:ssr` 会让 `/ABS/WORKTREE/.wrangler/deploy/config.json` 重定向到测试生成配置 `dist/server/wrangler.json`（name `ainews-app-test`、占位 D1 id、五阀全 false）。这只是本地状态，不是已误部署的证据；但它会被默认读取重定向的 Wrangler 命令（已核安装版源码：deploy、versions upload）沿用。因此生产预演/部署前必须重做生产构建并核生成配置，见下一节。已核同一版本的 `d1 execute`、`d1 migrations list` 不启用重定向，但远端操作仍一律显式 `--config`。

## 目标配置核验（预演与部署前）

```sh
(cd /ABS/WORKTREE && rm -rf dist .wrangler/deploy && env -u CLOUDFLARE_ENV npm run build)
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const f=["COLLECT_ENABLED","MODEL_CALLS_ENABLED","THIRD_PARTY_READER_ENABLED","EMAIL_ENABLED","DISCOVERY_ENABLED"];console.log(JSON.stringify({name:c.name,d1:(c.d1_databases||[]).map(d=>[d.binding,d.database_name,d.database_id]),flags:Object.fromEntries(f.map(k=>[k,(c.vars||{})[k]]))}))' /ABS/WORKTREE/dist/server/wrangler.json
(cd /ABS/WORKTREE && CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false npx --no-install wrangler deploy --dry-run --config /ABS/WORKTREE/dist/server/wrangler.json --outdir /ABS/SCRATCH/deploy-dry-run)
```

仅清自己工作树的 `dist` 与 `.wrangler/deploy`。核对输出：`name` 为 `ainews-app`（不是 `ainews-app-test`）；D1 的 binding/name/id 与 `/ABS/WORKTREE/wrangler.jsonc` 一致且不是 `00000000` 占位；五个 flag 与 `wrangler.jsonc` 顶层 `vars` 完全一致（不是测试全 false）。任一不符就停，不部署。Vite 部署使用框架生成的 `dist/server/wrangler.json`，不要强行改用根 `wrangler.jsonc`（它指向源码入口，会绕开框架构建产物）。

预演只编译、不上传，通过核验的生产构建也不证明生产绑定/routes/limits正确。bundle可能含非secret vars，不公开整份配置。smoke默认/`--dry-run` 零网络、`executed=false`，exit0仅代表计划合法。`backfill --dry-run`仍请求页面；模型probe会出站并可能花钱；SSR使用隔离本地fixture。不能把它们当同一安全等级。

## Owner-mutation：首次部署与更新

默认用现有CI：PR全gate、删防线变异、两路独立评审（一路不同家族）、所有owner项通过，评审绑定最终head后squash；核同一main SHA的ci与deploy成功。`gh run view APPROVED_RUN_ID --repo githonllc/ainews --json headSha,conclusion,jobs` 仅用于授权只读核查结论，不下载日志。迁移中不得取消job。成功不代表业务关口通过。

首次 provision 使用既有脚本创建 D1、R2、queues、Vectorize；先审资源和费用：`bash /ABS/WORKTREE/scripts/provision.sh`。常规更新不再provision、不seed/backfill/replay。迁移必须增量，不重建被引用表；不兼容先停。
仅CI不可用且owner明确批准时手工；先记fallback version、D1恢复点、迁移清单，确认未残留 `CLOUDFLARE_ENV=test`，只清自己工作树的构建产物，再按生产配置：

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler d1 migrations apply DB --remote --config /ABS/WORKTREE/wrangler.jsonc)
(cd /ABS/WORKTREE && rm -rf dist .wrangler/deploy && env -u CLOUDFLARE_ENV npm run build)
# 按上一节核验 dist/server/wrangler.json 后再部署：
(cd /ABS/WORKTREE && npx --no-install wrangler deploy --config /ABS/WORKTREE/dist/server/wrangler.json)
```

保持既有五阀；改变开关另开只改开关的owner批准PR。失败先查deployment/schema实际状态，禁止盲目重跑。接源另按 [信源规程](source-onboarding.md)。

## Remote-read-only：授权审计

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler d1 migrations list DB --remote --config /ABS/WORKTREE/wrangler.jsonc)
(cd /ABS/WORKTREE && npx --no-install wrangler deployments list --name ainews-app --config /ABS/WORKTREE/wrangler.jsonc --json)
(cd /ABS/WORKTREE && npx --no-install wrangler secret list --name ainews-app --config /ABS/WORKTREE/wrangler.jsonc --format json)
```

输出在受控端过滤：version去作者等个人字段；secret仅名称/日期，不能证明值正确。五个live flags只从owner批准的控制面读取五个名字和值，不下载可能带secret的Worker bundle。Gateway limit/credits/channel逐项查官方控制面；无权限记未知，不用付费调用探路。
以下各查询由reader一次一条SELECT，以 `--command` 传入；SQL可来自审定的绝对路径文件，但必须读成字符串再传，**不得用 `--file`**（Q3、Q5含多条语句，拆成独立文件逐条执行）：

**必须先做预检**（每个SQL文件、每次执行前都做，不能省）：去掉 `--` 注释行和空行后，文件只能有一个分号且在末尾，第一行以 `SELECT` 开头，不含写入、改结构或事务关键字。输出不是 `PRECHECK_OK` 就停，不执行下一条命令：

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

预检通过后，在同一个shell里执行同一个文件：

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler d1 execute DB --remote --json --config /ABS/WORKTREE/wrangler.jsonc --command "$(cat "$SQL_FILE")")
```

远端 `--file` 走bulk import，只回 `Total queries executed/Rows read/Rows written/Database size` 汇总（**假设，待补证据**：只在一台机器的临时文件里观察过，原件没有进入issue；[#26 的审计评论](https://github.com/githonllc/ainews/issues/26#issuecomment-6411383128) 只记录了只读查询 success=true、rows_written=0，不能证明 `--file` 的返回形状），不是查询证据；`--command` 才返回查询列（同样是**假设，待补证据**）。只SELECT，不自动repair/reconcile，不调用后台POST：

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

取证校验：退出码0；stdout是可解析JSON数组（有进度前缀即记异常，保留原件并注明后才剥离）；每个元素 `success===true` 且 `results` 为数组；`results[0]` 的列名等于下表预期列，缺列/多出汇总列即不是该查询的证据。零行结果只记“零行，列未校验”，不自动填0。

| 查询 | 预期列 |
|---|---|
| Q1 | slug, publish_mode, primary_domains, config_version, active_sources, articles, current_manual_approved, current_auto_approved |
| Q2 | id, slug, kind, status, interval_minutes, fail_count, last_ok_at, last_failed_at, next_fetch_at, jina_enabled |
| Q3 | key, value；day, channel, cap_micros, reserved_micros, spent_micros |
| Q4 | budget_day, channel, slot, model, status, n, settled_micros, unresolved_reserved_micros |
| Q5 | unknown_calls；last_hour_failed；gateway_hour_micros |
| Q6 | slug, id, kind, period_start, status, published_at, stored_items |
| Q7 | name, type |

Q1/Q2不导出feed URL；私有端逐行匹配已批准dossier，报告仅源id/批准引用/状态。`stored_items>0`不证明日报仍公开；`approvedArticleWhere`要求当前body_sha，grouped不等于批准。#25无新增migration对象。

## Remote-read-only：smoke routes / launch

每次线上只读GET都要在审批单里写明是谁、哪天授权的；示例Access origin须先核实际值。仅匿名GET，拒绝跟随跳转，不发凭证、不调server functions/Ask/反馈，不访问外部文章/SEC，不自动探索链接或修复空内容。

```sh
node /ABS/WORKTREE/scripts/smoke.ts --base-url https://news.ioenv.com --mode routes --access-origin https://ioenv.cloudflareaccess.com --online
node /ABS/WORKTREE/scripts/smoke.ts --base-url https://news.ioenv.com --mode launch --manifest /ABS/EVIDENCE/public-smoke-manifest.json --access-origin https://ioenv.cloudflareaccess.com --online
```

manifest仅含 `eventIds`正safe整数数组、`watchSlugs`小写字母数字连字符数组、`digests`数组（section四slug之一、真实YYYY-MM-DD、kind daily/weekly）、`funding`布尔（默认false）；数组默认空，重复路径去重，额外key拒绝。owner从真实公开记录选值，观察UTC时间及选择依据存相邻私有证据单，禁止填fixture ID/日期。日期不要求今天。无任意URL；manifest路径必须绝对。
`routes`可检查空RSS，但输出 `contentReadiness=unchecked`；`launch`必须四section RSS非空、至少event/watch/Technology daily/任一weekly/funding，且每个digest页至少1条、每个watch页至少1次命中（否则 `EMPTY_DIGEST`/`EMPTY_WATCH`）。#23未合入时funding会失败；#24是后台证据，不编公开URL。失败或不完整exit1，参数非法exit2；dry-run exit0不代表请求通过。`contentReadiness=checked`仅表示本次launch覆盖通过，不能代替M1–M4。每请求10s含流、全程120s、并发2、64case、实际读取每体2MiB，无重试。正常页面精确200，missing精确404；admin只接受401/403或指定HTTPS Access origin的302/303/307，200登录壳失败。这只证明匿名不可读，不证明管理员名单/server function鉴权。

## M1 financial：三方对账

固定UTC半开区间 `[start,end)`、SHA、Gateway id与pricing版本，保存Q3/Q4。时间列毫秒，金额整数微美元，1USD=1,000,000。settings cap、当天budgets cap和Gateway有效limit分别核，不把默认每日$2当真实limit。
从应用流水线选择真实generateText的write/reason completed且sent_at非空行，私有端核Gateway request/log metadata与实际计费；仅导出id、slot/model/channel、sent_at、budget_day、input/output_tokens、cost_micros、attempt。
按同budget_day/channel加总已settled的sent调用，包括带cost的failed，对照spent；in_flight/unknown reservation另列；跨午夜按预留日。解释重复attempt、estimate fallback、迟到日志、未知调用、非应用请求/渠道差异，禁止写库强行归零。

残差口径：`residual = budgetBooked − 账本记录的有符号值`，`budgetBooked` 指 `budgets` 记账的 spent。它只是记录值之差，不是实体分摊，不是发票证明；不得用当前 `cost_micros`/`estimated_micros` 重建被覆盖的旧attempt金额，`unknown=0` 也不证明旧金额为0。历史上 root 在 2026-10-24 观察到 gateway 记账多出 +37,835 微美元，原因未知（只发现与32个attempt>1行当前estimate之和数值相等，不是已核实的32笔扣费）；之后几日只证明记录值相符，不倒推 Oct24 已核账。报告不打印生产PII和原始secret。Jev历史确认不证明embed渠道；不能凭 `@cf/` 前缀记账。Gateway最终一致窗口未闭合或缺费用/权限/limit/credits，均记未知并约复核窗口。M1要求真实应用generateText completed、当天spent>0、实际费用匹配；binding探针和D1估价不足。

## 24h、停止条件、回滚

recordSuccess覆盖last_ok_at；文章日期跨度、一次快照、CI成功不能证明连续采集。root先查已有成功/调度/HTTP结果metadata，不导payload；若历史不足，owner安排两个指定Technology源按各自节奏超过24h的后续观察，逐轮含304/空轮、起止与缺口。小时快照只辅助；不补造历史、不改cron，持久化审计另立范围。
任一停止条件：Gateway一小时>500,000micros($0.50)，同类错误持续增加，任意unknown调用。Q5含估价只作保守告警，实际Gateway另核；无错误次数新阈值，受控端只映射固定类别/计数。立即停止放量/模型probe，报告root并准备仅将 `MODEL_CALLS_ENABLED` 改为 `"false"` 的独立紧急PR，保持COLLECT_ENABLED开启，仍需owner同意/review/deploy；不直接CLI改flag、不自动重发/reconcile/清reservation。在途调用不撤销，继续观察late settlement；恢复须另一个owner批准flag-only PR。
回滚预演是remote-read-only：选当前及上一已验证version，审schema兼容、vars/五阀、secret版本、cron/queues、绑定与迁移；不存在rollback dry-run。旧版会重开flag、用撤销secret或不兼容schema则禁止直接回滚，推荐保留当前安全配置的known-good forward-fix PR。
owner-mutation批准精确version后才执行：

```sh
(cd /ABS/WORKTREE && npx --no-install wrangler rollback APPROVED_VERSION_ID --name ainews-app --config /ABS/WORKTREE/wrangler.jsonc --message "Owner-approved incident rollback")
```

不省version让CLI猜。Worker rollback不恢复D1/R2；恢复数据另审恢复点、停写和损失窗口，禁DROP/down migration/覆盖正文。回滚后独立查activeversion、schema、flags及授权smoke，并修正main以免下次部署覆盖。

## Owner-mutation：逐项轮换

无零风险secret dry-run。审批只选一项，登记名称/用途/owner/最小权限/保管处/撤销日期，不收值。secret list仅名称，不证明功能。

| 对象 | 预检、批准后动作与独立验证 | 回退/影响 |
|---|---|---|
| GitHub CLOUDFLARE_API_TOKEN | 官方控制台新建最小权限token，安全UI更新；下次已批准deploy/job及activeversion验真，随后撤旧 | 不为验token额外deploy；失败退仍有效旧secret |
| Worker JINA_API_KEY及实际所需AI secret | 先核feature实际使用；批准后 `(cd /ABS/WORKTREE && npx --no-install wrangler secret put APPROVED_SECRET_NAME --name ainews-app --config /ABS/WORKTREE/wrangler.jsonc)` 私有交互输入；查version/名称及已批准功能观察 | put可能创建version/部署；关闭feature留未知，不开启或付费probe验key；正常窗口保留旧key，泄露立即撤旧 |
| FEEDBACK_SALT（未来#24） | 先确认合入与唯一键/UTC日界线；私下轮换，沿#24本地夹具/既有监控验证，不用smoke投票 | 推荐UTC日界线，日内换盐允许再投票；应急接受影响，泄露旧盐不复用，不改历史 |
| Access AUD/team-domain vars | 专门配置PR；保留owner控制面通道，真实登录与匿名拒绝分别核 | 防锁死；不是secret put，不导JWT/cookie |
| CF_BEACON_TOKEN public var | 当前空token策略继续，Engagement未知；启用须owner决定和配置review，公开HTML及官方Analytics验真 | 不替owner建站/填token；撤回专门PR置空 |

## 证据交接与 #26 gate

每格保存UTC、environment、SHA/version、命令/观察、脱敏原件路径、owner签收、四态结论（已验证/推断/假设/未知）；缺原件一律未知。生产快照805/93等不在本地复验范围，不引用为实时状态。

| Gate | 必须补的运营证据（本地代码/CI不能代替） | 当前 |
|---|---|---|
| M0 | owner历史验收、当前匿名拒绝与版本 | 未知（本单元未复验） |
| M1采集/编辑 | 指定双源>24h逐轮、真实Technology日报及全部输入当前body人工审核、管理员邮件另核身份/交付 | 未知 |
| M1费用 | 上述应用generateText/positive spent/Gateway实费对账、limit/credits/embed渠道 | 未知 |
| M2 | 真实event每条claim的article/body_sha/quote/offset能定位；授权后台Ask无答案拒答，真实模型另报预算获准 | 未知 |
| M3 | 真实实质进展仅命中一次、同revision幂等；无新进展不造数据 | 未知 |
| M4 | 四板块各active真实源/当期成功/当前人工批准内容、公开section/RSS；每个earnings reported/prior-period/prior-year/衍生数值对应filing单位period/accession及公式输入；Finance审核/notice；#23/#24最终独立签收 | 未知 |
| #25代码 / launch | 本地gate/变异/最终head双review；另有批准源、owner真实manifest、授权launch与运维交接 | 本文不签通过 |

owner仍须决定来源/Industry新域与激活渠道、门槛（推荐沿用）、Gateway读权限、24h窗口、Email Service/发件身份、Analytics（推荐继续空）、轮换窗口与#23/#24最终集成。每项只阻塞对应动作；全部原件签收后root才申请#26收口，不能以smoke全绿关epic。
