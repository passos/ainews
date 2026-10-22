# Personal News 架构契约

所有 issue 都按这份文件实现。改这里的约定要单独开 PR，并同步受影响的 issue。

需求来源，按优先级：

1. `docs/Newsren_Plan.md`：必须满足的产品需求。下文用 `N§x` 引用它的章节。
2. `docs/design/decisions.md`：使用者确认的 scope 决定与技术决定。
3. `docs/design/core-design.html`：核心设计 v0.2。AIHOT 只作参考。

标签：**已验证** = 读过官方文档原文；**假设** = 合理但未查，实现时由对应 issue 核实。

## 1. 运行时

一个 Worker：`ainews-app`，账号 simon（`5ad69dedffa38d8b7ab8ab17e051e410`），域名 `news.ioenv.com`，`workers_dev = false`。

```
src/server.ts            自定义入口：export default { fetch, scheduled, queue }
  fetch     → TanStack Start handler（公开站 + /admin）
  scheduled → 只做调度：挑出到期工作，发进队列
  queue     → pipeline/ 的消费者
```

TanStack Start 用 `@cloudflare/vite-plugin`。自定义入口可以同时导出 Queues 和 Cron 处理函数，绑定通过 `import { env } from "cloudflare:workers"` 读取（**已验证**，Workers 的 TanStack Start 指南）。

### 绑定

| 名字 | 类型 | 用途 |
|---|---|---|
| `DB` | D1 `ainews` | 全部业务数据，Drizzle 访问 |
| `BODIES` | R2 `ainews-bodies` | 正文，按版本存，不覆盖 |
| `Q_INGEST` | Queue | 采集 → 正文 → 分析，可并发 |
| `Q_GROUP` | Queue，`max_concurrency = 1` | 归组，批内顺序处理 |
| `Q_GENERATE` | Queue | 事件产物、报告、watch、Ask、发现 |
| `Q_DLQ` | Queue | 三条队列共用的死信队列 |
| `V_EVENTS` | Vectorize，1024 维 | 事件召回，元数据 `industry_id` |
| `V_CHUNKS` | Vectorize，1024 维 | 正文分块，Ask 和论断证据用 |
| `AI` | Workers AI | Jev、嵌入、`toMarkdown()` |
| `EMAIL` | Email Service `send_email` | 只发给管理员 |

### 变量与密钥

- 变量：`SITE_URL`、`ADMIN_EMAIL`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`AI_GATEWAY_ID`、`SEC_USER_AGENT`。
- 密钥（本地在 `.env.prod`，不进 git；线上用 `wrangler secret`）：`CF_AI_API_TOKEN`、`JINA_API_KEY`。`CLOUDFLARE_ACCOUNT_ID` 只给部署用。
- 安全阀，只有值为 `"true"` 才打开，默认全关：`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`EMAIL_ENABLED`、`THIRD_PARTY_READER_ENABLED`、`DISCOVERY_ENABLED`。
- 测试里安全阀一直关着；外部请求只连本地假服务。

## 2. 前端契约（使用者原文）

> Build a TanStack Start application with file-based TanStack Router routes, validated search params, route loaders, typed server functions, full-document SSR, and streaming. Keep server-only work behind explicit boundaries, choose the appropriate SSR mode per route, and target the deployment runtime without changing the application model.

落到本项目：

| 路由 | SSR 模式 | 数据 |
|---|---|---|
| `/`、`/s/$section`、`/e/$eventId`、`/digest/$section/$date`、`/w/$watch` | 完整 SSR，次要区块流式 | loader 调 `publication/` 的 server function |
| `/rss/*.xml` | server route，纯文本 | `publication/` |
| `/admin/*` | `ssr: 'data-only'` | `admin/` 的 server function，先过 Access 中间件 |

- search params 一律用 schema 校验（分页、板块、读者档位 `audience=student|educator|professional`）。
- 只在服务端运行的代码放在 `src/server/**`，用 `createServerFn` 暴露；组件里不出现 `env`。

## 3. 目录与依赖规则

```
src/
  server.ts                 入口
  routes/                   文件路由（公开 + admin）
  components/
  server/
    publication/            唯一的公开读取层：所有公开页面和 RSS 只从这里读
    admin/                  后台 server function + Access 中间件
    db/                     Drizzle schema、查询
  pipeline/                 collect · body · analyze · group · generate · digest · watch · ask · discover · edgar · funding
  providers/                模型客户端、llm_calls 账本、预算、Jina、toMarkdown
  lib/                      纯函数：URL 规范化、时区、hash、markdown 净化
drizzle/migrations/         wrangler d1 migrations 执行
tests/
```

架构测试（`tests/architecture.test.ts`）强制两条：

1. `routes/**` 和 `server/publication/**` 不 import `pipeline/**` 或 `providers/**` 的模型模块。这保证"读者打开页面不触发模型调用"。
2. `routes/**` 读数据只经过 `server/publication/**` 或 `server/admin/**`。

## 4. 流水线：确定性步骤与模型步骤

使用者要求：固定流程用确定性代码；快速判断用 Jev；写作和推理用通用模型。

| 步骤 | 做法 | 模型槽位 |
|---|---|---|
| 调度、到期挑选、补队 | 确定性 | — |
| 解析 RSS/Atom、列表页抽取 | 确定性（选择器写在信源配置里） | — |
| URL 规范化、去重、时区 | 确定性 | — |
| robots.txt、抓取梯选档 | 确定性 | — |
| 预筛：相关 / 不相关 | Jev `choice` | `judge` |
| 五维评分、内容类型、证据标签 | Jev `score` / `choice` | `judge` |
| 加权、门槛、发布模式 | 确定性 | — |
| 摘要、改写标题 | 写作模型 | `write` |
| 归组：并入哪个候选事件或新建 | Jev `choice`（候选来自 Vectorize） | `judge` + `embed` |
| Story Brief、三档解释、日报正文、课堂材料 | 写作模型 | `write` |
| 论断抽取与证据定位 | 推理模型；后端逐条校验引文确实在正文里 | `reason` |
| Ask、周报、行业影响、AI 起草板块配置、财报解读 | 推理模型 | `reason` |
| Watch：算不算实质进展 | 关键词与分类规则先过滤，剩下的用 Jev `noul` | `judge` |
| 信源发现：相关度 | Jev `score` | `judge` |
| 融资记录去重、财报数字 | 确定性（公司 + 轮次键；XBRL 数值） | — |

### 模型槽位（存在 settings 表，后台可改）

| 槽位 | 默认 | 计费渠道 |
|---|---|---|
| `judge` | `typesafe/jev`（`env.AI.run`） | Workers AI |
| `embed` | `@cf/baai/bge-m3` | Workers AI |
| `write` | `gemini-3.8-flash` | AI Gateway Unified Billing |
| `reason` | `claude-sonnet-5.5` | AI Gateway Unified Billing |

- Jev：结构化评估模型，输入 `state` 加一组 `noul` / `choice` / `score` 问题，输出概率和置信度；上下文 32,000 token；输入 $0.042 / 1M token，输出免费（**已验证**，模型目录页）。超过上下文时截断正文，只送标题、摘要和开头部分。
- 模型目录里有 `gemini-3.8-flash`、`claude-sonnet-5.5` 和 OpenAI 的 `gpt-5.5` 等（**已验证**）。替换成 OpenAI 等效模型只改槽位。
- **假设**：Unified Billing 调用的端点、请求格式，以及 `CF_AI_API_TOKEN` 就是网关鉴权 token。M0 用一次真实调用核实（#2）。
- **假设**：Workers AI 的费用不从 AI Gateway 预充的 credits 里扣。所以账本和预算按渠道分开。

## 5. 队列与状态

```
cron ─► Q_INGEST : collect(source) ─► body(article) ─► analyze(article)
                                                          │ 入选
                                                          ▼
                    Q_GROUP（顺序） : group(article) ─► 事件 revision + 1
                                                          │
                                                          ▼
                    Q_GENERATE : artifacts · claims · watch · digest · ask · discover
```

- 每篇文章在 `articles.stage` 记录阶段（`collected → body_ready → analyzed → grouped`）和 `stage_updated_at`。消息只带 id；消费者从库里读状态，重复投递时直接跳过已完成的阶段。
- cron 每 10 分钟扫一次卡住的行（阶段超过 30 分钟没变），重新入队。DLQ 里的消息在后台可以查看和重放。
- 每个消费者按最坏情况的批次定 `max_batch_size`：一次调用共享 15 分钟墙钟时间和 CPU 上限。

## 6. 幂等、并发与预算

- **模型调用账本** `llm_calls`：`logical_key` 唯一，状态 `pending → in_flight → completed | failed | unknown`，带 `lease_expires_at`。租约过期的行可以用条件 `UPDATE` 接管；调用已发出、结果没落库的标 `unknown`，后台人工核账。承诺的是"不重复发起、可以恢复"，不是"恰好一次付费"。
- **预算预留**：调用前用一条条件语句预留 `UPDATE budgets SET reserved = reserved + ? WHERE day = ? AND channel = ? AND reserved + spent + ? <= cap`。影响行数为 0 就不调用。AI Gateway 的 spend limit 是最终一致的，只作外层兜底（**已验证**："Spend limits are eventually consistent"）。
- **归组**：`Q_GROUP` 并发 1，批内 `for…of` 顺序处理，不用 `Promise.all`。候选事件 = Vectorize 召回 ∪ D1 里 30 分钟内新建的事件（Vectorize 索引是异步的）。`event_articles.article_id` 唯一。
- **事件 revision**：已批准的文章并入事件时，`events.revision + 1`。产物键 = `(event_id, type, audience, input_revision, prompt_version, model)`，只有 `input_revision` 等于当前 revision 时才写入，避免旧任务覆盖新结果。
- **多表更新**用 D1 `batch()` 一次提交。
- **正文**按 `bodies/{article_id}/{sha256}.md` 存，不覆盖；论断证据引用的是具体版本。

## 7. 发布与审核

- 每个板块有 `publish_mode = auto | review`。Finance 固定为 `review`（N§4 guardrails）。上线时所有板块都设为 `review`。
- 审核记录绑定内容版本：`reviews(article_id, body_sha, decision)`。`auto` 模式由规则写一条自动批准记录。
- 公开读取层只读已批准的输入：事件页、Brief、时间线、RSS、日报和 watch 只用已批准的文章及基于它们生成的产物。Finance 的产物发布前同样要审核。
- 模型输出和信源内容一律当不可信数据处理：markdown 渲染前先净化，只允许 `http`/`https` 链接；后台的写操作校验 `Origin`。
- Finance 每个页面显示"仅供参考，不构成投资建议"（N§4）。
- 发布后的更正写进 `corrections` 表，并在原页面公开显示（N§9 Trust）。

## 8. 抓取梯（0–3 档）

| 档 | 做法 |
|---|---|
| 0 | RSS 的 `content:encoded` |
| 1 | `fetch` 带 `Accept: text/markdown`，响应是 markdown 才用 |
| 2 | `fetch` HTML 或 PDF → `env.AI.toMarkdown()`（支持 PDF，**已验证**） |
| 3 | Jina Reader：全局开关 `THIRD_PARTY_READER_ENABLED`，并且信源单独打开时才用 |

- 需要浏览器渲染才能抓到的信源不收（使用者决定）。信源发现阶段就把它们过滤掉。
- 每个信源探测一次后记下 `fetch_rung`，连续失败 3 次重新探测；每篇文章记下实际用的档。
- 抓之前先查 robots.txt，禁止就不抓。单篇正文上限 2 MB；EDGAR 不走抓取梯（见 #21）。
- 只在已批准的信源和每个板块的一手来源白名单内抓取（N§6）。

## 9. 数据模型（核心表，列在实现时定）

| 表 | 关键约束 |
|---|---|
| `industries` | `slug` 唯一；`publish_mode`、`disclaimer`、`primary_domains`、提示词与门槛（JSON，带版本） |
| `sources` | `(industry_id, feed_url)` 唯一；`kind rss\|html`、`fetch_rung`、`jina_enabled`、健康指标、`status active\|paused\|candidate` |
| `articles` | `canonical_url` 唯一；`stage`、原文发布时间、抓取时间、`fetch_rung`、`body_sha` |
| `analyses` | `article_id` + `prompt_version` 唯一；五维分数、内容类型、证据标签、总分 |
| `reviews` | `(article_id, body_sha)` 唯一 |
| `events` / `event_articles` | `event_articles.article_id` 唯一；`events.revision` |
| `event_artifacts` | 见第 6 节的键 |
| `claims` / `claim_evidence` | 证据 = `(article_id, body_sha, quote, start, end, stance)` |
| `digests` | `(industry_id, kind, period_start)` 唯一 |
| `watches` / `watch_hits` | `watch_hits (watch_id, event_id, event_revision)` 唯一 |
| `questions` | Ask，只在后台 |
| `source_candidates` / `discovery_runs` | 发现 |
| `companies` / `filings` / `financial_facts` | EDGAR |
| `funding_rounds` | `(company_key, round_key)` 唯一，`superseded_by` 记录更正 |
| `corrections` | 公开更正 |
| `llm_calls` / `budgets` / `settings` | 见第 6 节 |

## 10. 测试、CI 与合并

- Vitest + `@cloudflare/vitest-pool-workers`；模型、Jina、外部网站都用本地假服务。
- CI（GitHub Actions）：`typecheck`、`lint`、`test`、`build`。main 的 ruleset 要求 CI 通过；只允许 squash 合并；开启 auto-merge；合并后删除分支。
- 合并到 main 后由 GitHub Actions 执行迁移和 `wrangler deploy`。
- 一个 issue 一个分支、一个 PR。PR 正文写 `Closes #n`。
