# Personal News 架构契约

所有 issue 都按这份文件实现。改这里的约定要单独开 PR，并同步受影响的 issue。

#75 的融资与匿名反馈条款是 #23／#24 后续功能 PR 必须实现并测试的契约，不表示新表、接口或功能已存在或部署。契约草稿与功能草稿编码、测试可并行；契约 PR 必须先通过独立评审及项目门禁并合并，核实合入 SHA 后，功能 PR 才可在各自评审及门禁通过后合并。实际两路独立评审（含跨家族）未完成前，所有相关 PR 保持 draft；作者自查不能代替独立评审。

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
| `BODIES` | R2 `ainews-bodies` | 正文，按版本存，不覆盖；`feed/` 原始输入除外 |
| `Q_INGEST` | Queue，`max_concurrency = 2` | 采集 → 正文 → 分析，可并发（上限 2，防突发，#53） |
| `Q_GROUP` | Queue，`max_concurrency = 1` | 归组，批内顺序处理 |
| `Q_GENERATE` | Queue | 事件产物、报告、watch、Ask、发现 |
| `Q_DLQ` | Queue | 三条队列共用的死信队列；它的消费者把消息存进 `dlq_messages` 表，后台从表里查看和重放（Worker 不能直接列出队列里的消息） |
| `V_EVENTS` | Vectorize，1024 维 | 事件召回，元数据 `industry_id` |
| `V_CHUNKS` | Vectorize，1024 维 | 正文分块，Ask 和论断证据用 |
| `AI` | Workers AI | Jev、嵌入、`toMarkdown()` |
| `EMAIL` | Email Service `send_email` | 只发给管理员 |

### 变量与密钥

- 变量：`SITE_URL`、`ADMIN_EMAIL`、`EMAIL_FROM`（默认 `digest@ioenv.com`，**假设**，待使用者确认）、`ACCESS_TEAM_DOMAIN`（完整 origin，如 `https://<team>.cloudflareaccess.com`）、`ACCESS_AUD`、`AI_GATEWAY_ID`、`SEC_USER_AGENT`、`CF_BEACON_TOKEN`（Web Analytics；空字符串 = 不输出 beacon 脚本）。
- 密钥（本地在 `.env.prod`，不进 git；线上用 `wrangler secret`）：`JINA_API_KEY`；`CF_AI_API_TOKEN` 只在 #3 的冒烟测试证明运行时需要它时才上传。`CLOUDFLARE_API_TOKEN` 是 Account API token（`ainews-deploy`），给本地 `provision.sh` 和 CI 部署用，GitHub secret 同名。`account_id` 写在 `wrangler.jsonc` 里，所以 CI 不需要 `CLOUDFLARE_ACCOUNT_ID`，它只给本地脚本用。
- #24 须使用 secret `FEEDBACK_SALT`，不得放入 vars、客户端或应用日志；配置与轮换属于运维，本契约不配置 secret 或修改开关。
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

server function 的请求路径是 `/_serverFn/*`，不在 Access 保护的 `/admin*` 之下，公开页面也用它，所以不能整段交给 Access。后台 server function 的鉴权：先读 `Cf-Access-Jwt-Assertion` 请求头，没有就读 `CF_Authorization` cookie，两者做同样的完整校验（#4）。Zero Trust 应用要关闭 "Cookie Path Attribute"，否则 cookie 只在 `/admin` 下发送。

- search params 一律用 schema 校验（分页、板块、读者档位 `audience=student|educator|professional`）。
- 只在服务端运行的代码放在 `src/server/**`，用 `createServerFn` 暴露；组件里不出现 `env`。
- #24 匿名按钮唯一写能力为 `src/server/feedback/api.ts::submitFeedback` POST server function；loader 仍只经 `publication/` 读取，读取不投票，也不查询个体投票记录。

## 3. 目录与依赖规则

```
src/
  server.ts                 入口
  routes/                   文件路由（公开 + admin）
  components/
  server/
    publication/            唯一的公开读取层：所有公开页面和 RSS 只从这里读
    admin/                  后台 server function + Access 中间件
    feedback/               #24 待实现：仅 api.ts::submitFeedback 可被公开路由／组件引用
    db/                     Drizzle schema、查询
  pipeline/                 collect · body · analyze · group · generate · digest · watch · ask · discover · edgar · funding
  providers/                模型客户端、llm_calls 账本、预算、Jina、toMarkdown
  lib/                      纯函数：URL 规范化、时区、hash、markdown 净化
drizzle/migrations/         wrangler d1 migrations 执行
tests/
```

架构依赖规则由 `tests/architecture.test.ts` 守护；以下反馈例外由 #24 实现并补测试，本契约 PR 不放宽现有守门器：

1. **R1**：公开路由／组件不能直接或间接到达 `server/db/**`、`pipeline/**` 或 `providers/**`；`publication/**` 和后台路由也不能到达 `pipeline/**` 或 `providers/**`。保留现有 publication／Access 后台边界；新增反馈例外仅在确切入口 `src/server/feedback/api.ts::submitFeedback` 停止公开调用链的 DB 遍历，绝不对整个 `feedback/` 目录停止遍历。必须另从 feedback 全部文件继续审计到 `pipeline/**`、`providers/**`、`server/admin/**` 的任何路径并禁止它们。
2. **R2**：`routes/**` 读数据只经过 `server/publication/**` 或 `server/admin/**`。公开路由／组件仅可引用上述确切文件的 `submitFeedback` API，不得引用 feedback 的 ops／identity 或其他内部模块；没有目录前缀白名单。`publication/` 始终只读，反馈不是第二个通用读取层。
3. **R3**：`routes/**`、`components/**` 禁止读取 env，反馈例外不放宽此规则。
4. **R4**：server function 只放在 `src/server/**`，每个后台 server function 仍须显式挂 Access 中间件；匿名反馈不授予后台权限，也不得靠伪造 Access 中间件绕过规则。

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
| 融资事实／字段更正提案 | 只从已批准正文提出带原文证据的提案 | `reason` |
| 融资身份规范化、同轮去重、字段操作；财报数字 | 确定性（稳定实体 + 实际事件键，具体轮次与 stage 统计桶分开；XBRL 数值）；实体／轮次／公告日期缺失或冲突交管理员确认，不按任意日期窗猜测 | — |

### 模型槽位（存在 settings 表，后台可改）

| 槽位 | 默认模型 id |
|---|---|
| `judge` | `typesafe/jev` |
| `embed` | `@cf/baai/bge-m3` |
| `write` | `google/gemini-3.8-flash` |
| `reason` | `google/gemini-3.8-flash` |

- 所有槽位都用 `env.AI.run(model, input, { gateway: { id: AI_GATEWAY_ID } })` 调用。模型页的代码示例对这几个模型都用 `env.AI.run`（**已验证**，`google/gemini-3.8-flash` 页面）。
- 计费渠道按槽位存在 settings 里，#3 实测定案：judge、write、reason 走 AI Gateway 预充的 credits（judge 由用户在 AI Gateway 日志里确认；write、reason 按 Unified Billing 的定义，**推断**）；embed 走 Workers AI 计费（**推断**：`@cf/` 前缀是 Workers AI 自有模型，未在日志里确认）。四个槽位走 binding 都调用成功（**已验证**，#3 的冒烟测试），生产用 binding，不需要 REST。
- Jev：结构化评估模型，输入 `state` 加一组 `noul` / `choice` / `score` 问题，输出概率和置信度；上下文 32,000 token；输入 $0.042 / 1M token，输出免费（**已验证**，模型目录页）。超过上下文时截断正文，只送标题、摘要和开头部分。
- 模型目录里也有 OpenAI 的 `gpt-5.5` 等（**已验证**）。换成 OpenAI 等效模型只改槽位。
- 金额一律存整数微美元（1 USD = 1,000,000）。

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

- 每篇文章在 `articles.stage` 记录阶段（`collected → body_ready → analyzed → grouped`，没入选的停在 `dropped`）和 `stage_updated_at`。任何写 `stage` 的语句同时写 `stage_updated_at = now`、`requeue_count = 0`。消息只带 `kind` 和 id；消费者按 `kind` 分发，从库里读状态，重复投递时直接跳过已完成的阶段。
- cron 每 10 分钟扫一次卡住的行（阶段超过 30 分钟没变），重新入队：`collected`、`body_ready` 回 `Q_INGEST`，`analyzed` 进 `Q_GROUP`。`dropped` 和 `grouped` 是终态。
- 入选文章由 #11 发进 `Q_GROUP`。DLQ 里的消息在后台查看和重放（见第 1 节 `Q_DLQ`）。
- 每个消费者按最坏情况的批次定 `max_batch_size`：一次调用共享 15 分钟墙钟时间和 CPU 上限。

## 6. 幂等、并发与预算

- **模型调用账本** `llm_calls`：`logical_key` 唯一，状态 `pending → in_flight → completed | failed | unknown`，带 `lease_expires_at`。租约过期的行可以用条件 `UPDATE` 接管；调用已发出、结果没落库的标 `unknown`，后台人工核账。承诺的是"不重复发起、可以恢复"，不是"恰好一次付费"。
- **预算预留**：调用前用一条条件语句预留 `UPDATE budgets SET reserved = reserved + ? WHERE day = ? AND channel = ? AND reserved + spent + ? <= cap`。影响行数为 0 就不调用。AI Gateway 的 spend limit 是最终一致的，只作外层兜底（**已验证**："Spend limits are eventually consistent"）。
- **归组**：`Q_GROUP` 并发 1，批内 `for…of` 顺序处理，不用 `Promise.all`。候选事件 = Vectorize 召回 ∪ D1 里 30 分钟内新建的事件（Vectorize 索引是异步的）。`event_articles.article_id` 唯一。
- **预算渠道**：`workers_ai`、`gateway`、`jina`。
- **事件 revision**：事件里"已批准文章的集合"变化时，`events.revision + 1`：已批准的文章并入事件，或事件里的文章被批准、被拒绝、被下线。所有板块上线时都是审核模式，大多数文章是先归组、后批准的，所以批准和拒绝的同一个 `batch()` 里也要加 revision（#11 提供语句，#9 调用）。产物键 = `(event_id, type, audience, input_revision, prompt_version, model)`，只有 `input_revision` 等于当前 revision 时才写入，避免旧任务覆盖新结果。
- **多表更新**用 D1 `batch()` 一次提交。
- **正文**按 `bodies/{article_id}/{sha256}.md` 存，不覆盖；论断证据引用的是具体版本。采集时 feed 自带的 `content:encoded` 原样存在 `feed/{sha256hex(canonical_url)}.html`（#5 写，在插入 `articles` 之前写，每次抓取覆盖写），它是正文抓取第 0 档的原始输入，不是正文版本；#6 按 `canonical_url` 算出键去读，有就用。

### #23 融资观察、身份与恢复契约

- `funding_observations` 须保留 `article_id`、完整 `body_sha`、提取版本、条目序号及原始提案／证据；原始观察不可被重试或身份更正覆盖。人工归属决议追加 revision 历史，不覆盖原始 payload。
- 应用 receipt 以稳定观察 ID 和决议 revision 识别，不能只按可纠正的公司／轮次键去重；业务落库、receipt、归属更新及更正审计须在同一 D1 `batch()` 原子提交，不删除历史 receipt。
- 模型账本 `completed` 不等于业务完成；保存的观察与业务完成标记须支持不重新调用模型的恢复。旧正文成功标记不得因提示词升级而清除或自动触发付费重析。
- `company_key`／`round_key` 须是已确认的稳定实体／实际融资事件键，不是显示名称或 stage 桶。版本更正不重算这些键；既有 active partial unique 继续保证同键最多一条 `superseded_by IS NULL` 记录。
- 每个融资版本须保存全部输入观察 ID 与各自决议 revision 的完整快照。批准和公开读取都须校验全部快照仍对应最新有效决议及归属；任一项失效就拒绝该版本，另须满足当前正文批准门槛，不能以仍有一个有效来源替代全输入校验。

## 7. 发布与审核

- 每个板块有 `publish_mode = auto | review`。Finance 固定为 `review`（N§4 guardrails）。上线时所有板块都设为 `review`。
- 审核记录绑定内容版本：`reviews(article_id, body_sha, decision)`。`auto` 模式由规则写一条自动批准记录。
- 公开读取层只读已批准的输入：事件页、Brief、时间线、RSS、日报和 watch 只用已批准的文章及基于它们生成的产物。Finance 的产物发布前同样要审核。
- 模型输出和信源内容一律当不可信数据处理：markdown 渲染前先净化，只允许 `http`/`https` 链接；后台的写操作校验 `Origin`。
- Finance 每个页面显示"仅供参考，不构成投资建议"（N§4）。
- 发布后的更正写进 `corrections` 表，并在原页面公开显示（N§9 Trust）。

### #23 融资事实、字段更正与发布

- 普通报道事实与原文明确更正分开。缺失字段保留既有值；原文明示的字段 `set`／`clear` 及投资方 `add`／`remove`／`replace` 分别表达，证据随提案保存，不把缺失当清空。
- 财务事实或实际身份修订须生成待审版本；身份确认不是发布许可，管理员确认后仍须独立通过 Finance 人工审核才可公开。
- 真实事件可用原文明示公司标识识别，官网 host 只是证据例子，也须支持管理员确认没有官网的稳定实体；不强制 host、外部公司库或额外抓取。
- 用具体融资轮次和原文明确的公告时间区分事件，不得把报道／抓取日期当公告日期。缺失或冲突先保存观察，再由管理员关联；日期未知可明确确认未知，不伪造日期，不以任意时间窗或相似度阈值代替证据。信息不全的十篇报道可以十条观察人工关联到一轮，不承诺所有输入全自动去重。
- 公开融资事实须同时满足身份已确认、版本已发布且未被替代、当前已批准正文及最新有效观察归属支持，并通过 §6 全输入快照校验。来源移轮、拆分或撤销后，历史来源不能继续赋予旧轮公开资格。
- 反例约束：已发布 R 的输入为 A+B，A 改归 S 后，即使拒绝 R 的待审修订、恢复旧 published R，且 B 仍有效，引用 A 旧决议的 R 也不得获批准或公开；必须重新形成符合全部当前输入的待审版本并审核，不能靠 B 复活旧事实。
- 公开更正仅展示已批准祖先到最终批准版本的差异，不泄漏中间待审字段。

### #24 匿名反馈的唯一公开写例外

- 唯一公开写 API 为 `src/server/feedback/api.ts::submitFeedback` POST，只收匿名“有用”（1）／“没用”（-1）投票，严格输入为 `{target:"event"|"digest",id:positive-safe-integer,value:1|-1}`，不收文字或额外身份字段。其目标必须为当前可公开读取的事件 Story Brief 或日报；只能为资格校验读取公开目标，只能写 `feedback` 表，不得改文章、审核、产物、账本、预算或其他表。
- POST 须经过既有全局 Origin 检查，缺失或跨域 Origin 均拒绝；不调用模型、不发队列、不授予后台写权限，不提供 GET 个体投票查询或通用公开 JSON 写 API。公开读取仍经只读 `publication/`，公开反馈结果仅聚合。
- IP 只取服务端请求头 `CF-Connecting-IP`；不接受 body 的 IP／hash／day、`X-Forwarded-For` 或客户端身份。缺 IP 或 `FEEDBACK_SALT` 时拒写并返回不可用，不退回未加盐哈希。
- `day` 由服务端按 UTC 生成，`voter_hash = sha256(IP + day + FEEDBACK_SALT)`。原始 IP 不入库或客户端偏好；原始 IP、salt、voter_hash 均不返回客户端或写应用日志，不公开个体投票者信息。
- 数据库唯一键 `(target_type, target_id, day, voter_hash)` 须原子改票，重复投票只更新 `value`。它代表每网络地址每目标每天一票，不代表识别真实个人，也不承诺防代理刷票；不新增限频服务。读者偏好仍只留浏览器，不上传完整偏好。

## 8. 抓取梯（0–3 档）

| 档 | 做法 |
|---|---|
| 0 | RSS 的 `content:encoded`；信源可以设 `summaryIsBody`，直接把 RSS 摘要当正文（arXiv 用这个） |
| 1+2 | 一次 `fetch`，`Accept: text/markdown, text/html;q=0.9`：返回 markdown 就直接用（第 1 档）；返回 HTML 或 PDF 就交给 `env.AI.toMarkdown()`（第 2 档，支持 PDF，**已验证**） |
| 3 | Jina Reader：全局开关 `THIRD_PARTY_READER_ENABLED`，并且信源单独打开时才用 |

Jina 按 read 槽位走模型客户端，写进 llm_calls，渠道 jina。

第 1 档只对在 Cloudflare 上开了 Markdown for Agents 的站点有效。arXiv 和 MIT Technology Review 都返回 HTML（**已验证**，细化 #6 时实测），所以 1、2 档合成一次请求，不多发一次。arXiv 的 robots.txt 要求 `Crawl-delay: 15`。

- 需要浏览器渲染才能抓到的信源不收（使用者决定）。信源发现阶段就把它们过滤掉。
- 每个信源探测一次后记下 `fetch_rung`，连续失败 3 次重新探测；每篇文章记下实际用的档。
- 抓之前先查 robots.txt，禁止就不抓。单篇正文上限 2 MB；EDGAR 不走抓取梯（见 #22）。
- 只在已批准的信源和每个板块的一手来源白名单内抓取（N§6）。
- 重定向手动跟随，最多 5 跳；每一跳都查协议、白名单、robots.txt。一次抓取内同主机的跳转共用 hop 0 的抓取间隔；跨主机跳转各自抢时段，抢不到就推迟，带剩余等待时间重发消息，重发后从文章 URL 重新开始；被拦下的重定向不再走第 3 档。
- robots.txt 请求失败（网络错误、5xx、429、越出白名单的重定向）时保留旧缓存，1 小时后再请求；没有旧缓存时按全部禁止处理，也是 1 小时后再请求。

## 9. 数据模型（核心表，列在实现时定）

| 表 | 关键约束 |
|---|---|
| `industries` | `slug` 唯一；`publish_mode`、`disclaimer`、`primary_domains`、提示词与门槛（JSON，带版本） |
| `sources` | `(industry_id, feed_url)` 唯一；`kind rss\|html`、`fetch_rung`、`jina_enabled`、健康指标、`status active\|paused\|candidate` |
| `articles` | `canonical_url` 唯一；`stage`、原文发布时间、抓取时间、`fetch_rung`、`body_sha` |
| `analyses` | `article_id` + `prompt_version` 唯一；五维分数、内容类型、证据标签、总分 |
| `reviews` | `(article_id, body_sha)` 唯一；`body_sha` 不能为空，没有正文时用摘要文本的 hash |
| `dlq_messages` | 死信消息原文、来源队列、失败次数、重放状态 |
| `events` / `event_articles` | `event_articles.article_id` 唯一；`events.revision` |
| `event_artifacts` | 见第 6 节的键 |
| `claims` / `claim_evidence` | 证据 = `(article_id, body_sha, quote, start, end, stance)` |
| `digests` | `(industry_id, kind, period_start)` 唯一 |
| `watches` / `watch_hits` | `watch_hits (watch_id, event_id, event_revision)` 唯一 |
| `questions` | Ask，只在后台 |
| `source_candidates` / `discovery_runs` | 发现 |
| `companies` / `filings` / `financial_facts` | EDGAR |
| `funding_rounds` | `company_key` + `round_key` 标识稳定实体／实际融资事件；既有 active partial unique 仅覆盖 `superseded_by IS NULL`；`superseded_by` 保留更正版本链；身份确认、证据元数据及全部观察／决议 revision 输入快照随版本保存 |
| `funding_observations`（#23 待建） | `(article_id, 完整 body_sha, 提取版本, 条目序号)` 唯一；原始 payload／证据不可变；归属决议保留 revision 历史，应用 receipt 对应稳定观察 ID + 决议 revision |
| `feedback`（#24 待建） | `target_type`、`target_id`、`day`、`voter_hash`、`value`、`created_at`；类型仅 event／digest，值仅 1／-1；唯一键及目标资格见 §7 |
| `corrections` | 公开更正 |
| `llm_calls` / `budgets` / `settings` | 见第 6 节 |

**已知限制**：`canonical_url` 在所有板块之间唯一，一篇文章只属于最先采到它的信源所在的板块，只按那个板块的配置分析。同一篇文章同时出现在两个板块的信源里时，第二个板块看不到它。以后如果需要，再把分析结果改成按 `(article_id, industry_id)` 存。

### 迁移

从 `COLLECT_ENABLED` 第一次打开起，`articles` 和所有被外键引用的表不再用"重建表"的迁移；加列用 `ALTER TABLE ADD COLUMN`；需要改 CHECK 的，另开 issue 先设计。

#23／#24 新列只用 `ALTER TABLE ADD COLUMN`，新表／索引用 `CREATE TABLE`／`CREATE INDEX`；不改原表 CHECK、不重建 `funding_rounds`、不改既有 active unique 索引。实际迁移由后续功能 PR 提供，本契约 PR 不生成 SQL。

## 10. 测试、CI 与合并

- Vitest + `@cloudflare/vitest-plugin`（原 `@cloudflare/vitest-pool-workers` 已改名并弃用，**已验证**，npm）；模型、Jina、外部网站都用本地假服务。CI 里没有 Cloudflare 凭证也必须能跑测试。
- 本地测试和 `test:ssr` 用 `wrangler.jsonc` 里的 `env.test`（#2）。它只声明 DB、BODIES、四条队列和 vars，不包含 AI、Vectorize 和 send_email，因为这三个绑定在本地也会开一个远程代理会话，要凭证（**已验证**，#2：不用 `env.test` 时 vitest 报 "Failed to start the remote proxy session"）。它的 `routes` 和 `crons` 清空，以免测试用的 Worker 绑到生产域名上。新增的绑定如果本地测试要用，同时加进 `env.test`；用不到的，测试里用假对象。
- 非法的 search param 由 TanStack Router 用 307 重定向到规范 URL，比如 `/?audience=bogus` 跳到 `/`（**已验证**，生产环境，2026-10-23）。冒烟测试里的 `fetch` 默认跟随重定向，只看最终状态码；要断言"不跳转"，就加 `redirect: "manual"`。
- CI 跑在使用者 wsl 主机上的 self-hosted runner：`runs-on: [self-hosted, wsl]`，runner 是 `wsl-ainews-1` 和 `wsl-ainews-2`，用主机上的 `~/runners/setup.sh ainews:2` 注册，以 systemd 用户服务运行。原因：GitHub 托管的 runner 被账号账单拦住了（2026-10-22）。这台主机同时跑着其他仓库的 runner，`_work` 在两次运行之间不清空，所以测试和脚本不能写死端口（向系统要空闲端口），不能依赖工作目录以外的状态；每个 job 都要设 `timeout-minutes`。
- CI（GitHub Actions，`ci.yml`）：`typecheck`、`lint`、`test`、`build`、`test:ssr`。main 的 ruleset 要求 CI 通过；只允许 squash 合并；开启 auto-merge；合并后删除分支。
- 同一个 `ci.yml` 里的 `deploy` job：只在 main 上、CI 通过后执行迁移和 `wrangler deploy`。
- 一个 issue 一个分支、一个 PR。PR 正文写 `Closes #n`。
