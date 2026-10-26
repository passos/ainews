# AGENTS.md

给接手本仓库的编码 agent（Codex、Gemini/agy 或其他）。先读完本文件再动手。

本项目是 **Daily**：在一个 Cloudflare Worker 上自己找热点、自己写日报的新闻站，单管理员，多板块。
生产站点 <https://news.ioenv.com>，仓库 `githonllc/ainews`，总 epic 是 #26。

---

## 1. 开工前按顺序读

| 顺序 | 文件                                | 作用                                                   |
| ---- | ----------------------------------- | ------------------------------------------------------ |
| 1    | `docs/Newsren_Plan.md`              | 产品需求，**必须满足**。引用写作 `N§x`                 |
| 2    | `docs/design/decisions.md`          | 使用者确认过的 scope 与技术决定，按轮次追加            |
| 3    | `docs/architecture.md`              | **架构契约**。所有 issue 按它实现；要改契约，单独开 PR |
| 4    | 本文件                              | 现状、流程、红线、剩余工作                             |
| 5    | 你要做的 issue 的**正文和全部评论** | 评论里有正文写完之后才定下的决定和订正                 |

需求冲突时的优先级：`Newsren_Plan.md` > `decisions.md` > `architecture.md` > issue 正文 > 代码注释。
发现冲突就停下，写明冲突的两处原文，问使用者。不要自己挑一个。

---

## 2. 现状（快照：2026-10-24，以下数字会过期，用第 7 节的命令重查）

**已上线**（M0 全部，M1 的一部分）：

| issue | 内容                                                                     | 关键文件                                                       |
| ----- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| #2–#4 | 骨架、部署、CI；数据模型、模型客户端与调用账本；后台 Access 鉴权         | `src/server.ts`、`src/providers/`、`src/server/admin/`         |
| #5    | RSS / 列表页采集、去重、信源健康                                         | `src/pipeline/collect/`                                        |
| #6    | 正文抓取梯 0–3 档、robots、按主机限速                                    | `src/pipeline/body/`                                           |
| #7    | 预筛、五维评分、标签、摘要（Jev + Gemini）                               | `src/pipeline/analyze/`                                        |
| #8    | 四个板块的种子配置（Technology、Education、Industry、Finance）与两个信源 | `src/server/db/seed/`                                          |
| #10   | 公开站 `/`、`/s/$section`、RSS                                           | `src/routes/`、`src/server/publication/`                       |
| #43   | 写摘要被 thinking token 截断的修复                                       | `src/pipeline/analyze/prompts.ts`、`src/providers/adapters.ts` |

**生产开关**（`wrangler.jsonc` 顶层 `vars`）：`COLLECT_ENABLED="true"`，`MODEL_CALLS_ENABLED="true"`；
`THIRD_PARTY_READER_ENABLED`、`EMAIL_ENABLED`、`DISCOVERY_ENABLED` 都是 `"false"`。`env.test` 里五个全是 `"false"`。

**生产数据**：两个信源（arXiv cs.AI、MIT Technology Review）每小时抓一次。四个板块都是 `publish_mode='review'`，
所以**没有任何文章被批准，公开站是空的**。批准要等后台审核队列（#9）上线。

**预算**：每天 $2，按渠道存在 `settings` 的 `budget.caps`：`gateway` $1.90（Jev、Gemini），
`workers_ai` $0.10（嵌入），`jina` $0。账本 `llm_calls` 在超出上限前拒绝调用。

**执行中**（接手时先看 GitHub 上的实际状态）：

- #46 一次性回填两个信源最近 3 天的文章，PR 是 #48。流程：评审 → 合并 →
  先跑 `--dry-run` 给使用者看 → 确认后 `--apply`。
- 16 篇在 #43 之前没写出摘要的文章已重置回 `body_ready`，由补队重新分析。重新分析会按新的 `prompt_version`
  插入新的 `analyses` 行，旧的空摘要行保留，所以核对时只看每篇文章最新 `prompt_version` 的那一行。

---

## 3. 剩余工作

### 3.1 M1 · Stage 1（先做完）

M1 关口（#26）：Technology 连续采集 24 小时以上，出过日报，所有条目都经过审核；账本里有真实调用的 `completed` 行，
`budgets` 当天 `spent_micros > 0`，并且和 AI Gateway 日志对得上。

| 顺序 | issue                                         | 档位   | 依赖   | 说明                                                                                                                                    |
| ---- | --------------------------------------------- | ------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | #46 回填 3 天                                 | opus   | —      | 见上                                                                                                                                    |
| 2    | #45 首页 1280px 空白                          | sonnet | —      | 小 UI 改动；**合并前要使用者看截图批准**                                                                                                |
| 3    | #9 后台：板块、信源、审核队列                 | opus   | #10 ✅ | 先读它的 6 条评论（列名、恢复信源、重新分析、覆盖写 NULL、corrections 索引、embed 计费渠道）                                            |
| 4    | #11 事件归组与时间线                          | opus   | #9     | 用 `Q_GROUP`（并发 1）和 Vectorize `V_EVENTS`；批内 `for…of` 顺序处理；候选 = Vectorize 召回 ∪ D1 里 30 分钟内新建的事件（契约第 6 节） |
| 5    | #12 日报与管理员邮件                          | opus   | #11    | 标 `needs-owner`：要使用者先接好 Email Service、确认发件地址                                                                            |
| 并行 | #34 架构测试改查传递导入                      | sonnet | —      | 测试改动                                                                                                                                |
| 并行 | #39 `restTransport` 的 REST 端点返回 No route | —      | —      | 生产只用 binding，不阻塞；没细化                                                                                                        |

**#9、#11、#12 的「实现细化」写于 2026-10-22，那时仓库还没有代码。** 已经做完的 issue，每个在开工前都订正了 7–13 处
（文件名、表的列、函数签名、测试方式）。所以开工前逐条对照现在的代码核对细化里的每个路径、列名和函数，
把订正写成 issue 评论，再写代码。细化与代码矛盾时，以代码和契约为准，并在 PR 正文写明。

### 3.2 M2–M4（#13–#25）

只写了范围和验收，标 `needs-refine`。派发或开工前先写「实现细化」：读需求和现有代码，给出精确改动点、
不变量、命令级验收和执行档位，作为评论贴到 issue 上，然后改 label 为 `refined`。按 issue 正文里的「依赖」排顺序。

| 里程碑 | issue   | 关口                                                   |
| ------ | ------- | ------------------------------------------------------ |
| M2     | #13–#16 | 事件页每条论断都能点到原文片段；Ask 对查不到的问题拒答 |
| M3     | #17–#19 | watch 只在有实质进展时命中，同一进展不重复命中         |
| M4     | #20–#25 | 四个板块全部在线；财报里每个数字都链接到 filing        |

---

## 4. 红线（违反任一条，PR 不能合并）

### 开关与花钱

- 五个安全阀只认字符串 `"true"`。**功能 PR 不改开关。** 改开关单独开一个只改那几行的 PR，并且要使用者明确同意。
- 任何会花真钱的动作（打开开关、真实模型调用的脚本、Jina）先得到使用者同意，并写明预计金额。
- 所有模型和 Jina 调用都经过 `src/providers/models.ts` 的 `createModelClient()`，不直接调 `env.AI.run`。
  它负责开关检查、账本 `llm_calls`、预算预留与结算。
- 金额一律是整数微美元（1 USD = 1,000,000）。
- Gemini 的 thinking token 计入 `maxOutputTokens`。新的 `write` / `reason` 调用要显式设 thinking（参考
  `WRITE_THINKING = { thinkingLevel: "low" }`），并在合并前用几次真实调用证明 `finishReason` 是 `STOP`
  （`scripts/probe-write.ts` 是现成的探测脚本）。#43 就是这样踩坑的：2000 token 被 thinking 用光，16 篇没摘要。

### 数据库

- **不写重建表的迁移。** `articles` 和所有被外键引用的表只能 `ALTER TABLE … ADD COLUMN` 或 `CREATE INDEX`。
  要改 CHECK 或唯一键，先开 issue 设计迁移。迁移用 `npm run db:generate` 生成，生成后再跑一次应输出 "No schema changes"。
- 写 `articles.stage` 的语句同时写 `stage_updated_at = now`、`requeue_count = 0`，并带上"期望的旧 stage"条件。
- 多表写入用 D1 `batch()`。需要"前一步成功才写下一步"时用 `WHERE changes() = 1` 串起来
  （远端 D1 已实测：`changes()` 取同一 batch 里上一条语句的影响行数）。参考 `src/pipeline/analyze/analyze.ts`。
- 正文按版本存：`bodies/{article_id}/{sha256}.md`，不覆盖；论断证据引用具体版本。`feed/{sha256(canonical_url)}.html`
  是采集时的原始输入，可以覆盖，不是正文版本。
- 事件 revision（契约第 6 节）：事件里"已批准文章的集合"变化时 `events.revision + 1`，批准和拒绝要在同一个
  `batch()` 里改 revision；事件产物只有 `input_revision` 等于当前 revision 时才写入，避免旧任务覆盖新结果。
- 账本的 logical key 要包含决定结果的所有输入（例如正文 `body_sha`），否则换了输入会拿回旧答案。
- `promptVersion`（`src/pipeline/analyze/questions.ts`）由实际发出的请求自动算 hash；只有改了 `state` 字段、
  打分逻辑或存储格式才手动加 `ANALYZE_CODE_VERSION`。

### 发布与安全

- 公开页面和 RSS 只经过 `src/server/publication/` 读数据；"已批准"只有一个定义：`approvedArticleWhere`
  （`src/server/publication/articles.ts`）。不要另写一份。
- Finance 永远人工审核：判断用 `FINANCE_SLUG` 常量和 `effectivePublishMode()`（`src/pipeline/analyze/analyze.ts`）。
  Finance 的每个页面显示免责声明。
- 模型输出和信源内容都是不可信数据：链接只允许 http/https（`safeHttpUrl`，`src/lib/url.ts`），markdown 渲染前净化，
  Jev 的 choice 必须在选项里。
- 抓取前查 robots.txt；用项目 UA；遵守 crawl-delay（`claimHostSlot`）；只抓信源域名和板块 `primary_domains`。
  不收需要浏览器渲染的信源。
- 后台鉴权：server function 的请求路径是 `/_serverFn/*`，不在 Access 保护的 `/admin` 之下。所以每个后台 server
  function 都要显式挂 `src/server/admin/` 的 Access 中间件；写操作用 POST，才会经过 `src/server/edge.ts` 的 Origin 检查。
- 公开代码不能接触模型：`routes/**` 和 `server/publication/**` 不能直接或间接 import `pipeline/**` 或 `providers/**`
  （`tests/architecture.test.ts`，规则 R1）。

### 配置与环境

- 改了 `wrangler.jsonc` 就跑 `npx wrangler types`，提交更新后的 `worker-configuration.d.ts`（CI 用 `--check` 检查）。
- 新绑定如果本地测试要用，同时加进 `env.test`；测试不能依赖 Cloudflare 凭证或真实网络。
- `.env.prod` 存生产密钥，不进 git，不打印到日志、PR 或 issue 里。

### Git

- 一个 issue 一个分支、一个 PR，正文写 `Closes #n`。只 squash 合并，不产生 merge commit，同步用 rebase。
- commit message、PR 和 issue 正文里**不写任何 AI 署名或广告语**（例如 `Co-Authored-By: …`、"Generated with …"）。
- 只提交你自己的改动；不要动别人的分支或 worktree。

---

## 5. 一个 issue 的流程

```
读 issue + 评论 ──► 对照代码核对细化（订正贴评论）──► 分支 ──► 实现 + 测试
      ▲                                                          │
      │                                                          ▼
      │                                        本地 gate 全绿 + 删防线变异全红
      │                                                          │
      │                                                          ▼
      └──── 修改 ◄── 评审意见 ◄── 两路独立评审 ◄── 开 PR（CI 绿，auto-merge 关）
                                      │ 通过
                                      ▼
            needs-owner？──是──► 停在 draft，等使用者确认（截图、阈值、文案）
                │否                    │确认
                ▼                      ▼
        gh pr merge --auto --squash --match-head-commit <评审过的 sha>
                ▼
        main 上 ci + deploy 成功 ──► 部署后核对（第 7 节）──► 报告
```

- **本地 gate**：`npx wrangler types --check`、`npm run typecheck`、`npm run lint`、`npm test`、`npm run build`、`npm run test:ssr`。
- **删防线变异**：每个守护规则（条件、过滤、开关检查）删掉后至少有一个测试变红；没变红就补测试。在 PR 正文列出做过的变异。
- **两路评审**：一路来自与实现者不同的模型家族，一路看"是否满足 issue 和契约"。发现取并集，每条回源码核实后再处理。
- **head 变了，评审作废**：合并用 `--match-head-commit` 绑定评审过的提交。
- **PR 正文**写：做了什么、与细化或契约不同的地方（偏离）及理由、未验证的项。
- **CI** 跑在使用者 WSL 主机上的 self-hosted runner（`runs-on: [self-hosted, wsl]`）。测试不能写死端口，
  不能依赖工作目录以外的状态。runner 偶尔会在 `setup-node` 卡十来分钟，job 有 `timeout-minutes`；不要在迁移步骤中途取消部署。

---

## 6. 需要使用者处理的事

不要替使用者做这些决定：

- 打开或关闭任何开关；任何花真钱的调用。
- 板块的"什么重要 / 什么是噪声"、门槛、信源名单（#8 的方式：draft PR + 确认清单）。
- 公开站 UI 改动：合并前给使用者看 375px 和 1280px、亮色和暗色截图。
- #12：Email Service 接入 `ioenv.com`，确认发件地址（契约里 `digest@ioenv.com` 是假设）。
- Web Analytics 的 `CF_BEACON_TOKEN`（现在是空字符串，beacon 不输出）。
- embed（`@cf/baai/bge-m3`）的计费渠道：要有 AI Gateway 日志读权限的凭据才能确认（#9 评论里有 log id）。

提问时给出：背景、真正的问题、每个选项的代价和后果、你的推荐和理由。

---

## 7. 生产操作

先加载凭证（只在使用者机器上；不要回显内容）：

```sh
set -a; . ./.env.prod; set +a
```

常用只读查询：

```sh
npx wrangler d1 migrations list ainews --remote          # 应为 "No migrations to apply!"
npx wrangler d1 execute ainews --remote --json --command \
  "SELECT stage, count(*) n FROM articles GROUP BY stage"
npx wrangler d1 execute ainews --remote --json --command \
  "SELECT slot, status, count(*) n, sum(cost_micros) c FROM llm_calls GROUP BY slot, status"
npx wrangler d1 execute ainews --remote --json --command \
  "SELECT * FROM budgets ORDER BY day DESC LIMIT 3"
npx wrangler d1 execute ainews --remote --json --command \
  "SELECT id, name, status, fail_count, last_error FROM sources"
curl -s -o /dev/null -w '%{http_code}\n' https://news.ioenv.com/
```

**部署后核对**：main 上 `ci` 和 `deploy` 都 success；迁移已应用；新表、新列、新索引在生产存在；
相关页面状态码正确；开关值没被意外改动。把原始输出贴在 PR 或 issue 评论里。

**停止条件**（任一出现，立即开一个只把 `MODEL_CALLS_ENABLED` 改回 `"false"` 的 PR，再报告）：

- gateway 一小时内花费超过 $0.50；
- 同一类错误反复出现（例如 `llm_calls` 里同一错误的 `failed` 行持续增加）；
- `llm_calls` 出现 `status='unknown'` 的行（调用已发出，结果没落库，要人工核账）。

关模型调用时 `COLLECT_ENABLED` 保持打开：新文章停在 `body_ready`，重新打开后补队会接着处理。

**写生产数据**（种子、回填、恢复 SQL）：先 dry-run 或先查影响行数，给使用者看，确认后再执行；只执行一次；
执行前后的计数都贴出来。

---

## 8. 已知缺口（已记录，未处理）

| 缺口                                                                                                                                                  | 记录在      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 同一 `prompt_version` 下重新分析时，`analyses (article_id, prompt_version)` 唯一键挡住新结果                                                          | #9 评论     |
| `corrections` 缺 `(target_type, target_id, created_at DESC, id DESC)` 索引；#9 开始写更正时加                                                         | #9 评论     |
| 清除人工覆盖要写 NULL，不写空字符串                                                                                                                   | #9 评论     |
| embed 的计费渠道未确认                                                                                                                                | #9 评论     |
| `canonical_url` 全局唯一：一篇文章只属于最先采到它的板块                                                                                              | 契约第 9 节 |
| 架构测试：R1 的起点不含 `src/components/**`、禁止集不含 `server/db`；R2 只查路由的直接导入                                                            | #34         |
| Jina（第 3 档）要同时满足：`THIRD_PARTY_READER_ENABLED`、信源 `jina_enabled=1`、`MODEL_CALLS_ENABLED`、`JINA_API_KEY`、`jina` 预算大于 0（现在是 $0） | 契约第 8 节 |
| `restTransport` 对 gateway 模型返回 No route；生产只用 binding                                                                                        | #39         |

---

## 9. 常用命令与脚本

| 命令                                       | 作用                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `npm run dev`                              | 本地开发；用生产绑定，需要 Cloudflare 登录                            |
| `npm test`                                 | vitest：`workers` 项目 + `node` 项目（UTC 与 Asia/Shanghai 两个时区） |
| `npm run test:ssr`                         | 用 `env.test` 构建，再用 `vite preview` 做 SSR 冒烟                   |
| `npm run db:generate`                      | 从 `src/server/db/schema/` 生成迁移                                   |
| `npm run seed:local` / `seed:remote`       | 板块与信源种子；`ON CONFLICT DO NOTHING`，可重复跑                    |
| `scripts/try-analysis.ts`                  | 对夹具文章跑真实 Jev 分析，不进库、不进账本（花钱，`--dry-run` 不花） |
| `scripts/probe-write.ts`                   | 对 write 槽位做真实探测，看 `finishReason` 和 thinking token          |
| `scripts/smoke-models.ts`、`smoke-body.ts` | 模型与正文抓取冒烟                                                    |
| `scripts/provision.sh`                     | 创建 D1、R2、队列、Vectorize（幂等）                                  |

Node 24（`.nvmrc`）。`scripts/` 下的 `.ts` 用 `node --import ./scripts/ts-resolve.mjs` 运行。
