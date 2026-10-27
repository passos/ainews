# Daily 架构契约

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
- 密钥（本地在 `.env.prod`，不进 git；线上用 `wrangler secret`）：`JINA_API_KEY`；`CF_AI_API_TOKEN` 只在 #3 的冒烟测试证明运行时需要它时才上传。`CLOUDFLARE_API_TOKEN` 是 Account API token（`ainews-deploy`），给本地 `provision.sh` 和 CI 部署用，GitHub secret 同名。`account_id` 写在 `wrangler.jsonc` 里，所以 CI 不需要 `CLOUDFLARE_ACCOUNT_ID`，它只给本地脚本用。`IP_HASH_SALT`（#132）：公开写入口给网络地址做哈希用的盐，至少 32 个随机字节，所有公开写入口共用，只用 `wrangler secret` 设置，不进 `vars`；缺失或为空时，需要它的写入口拒绝写入。
- 安全阀，只有值为 `"true"` 才打开，默认全关：`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`EMAIL_ENABLED`、`THIRD_PARTY_READER_ENABLED`、`DISCOVERY_ENABLED`、`READER_WATCH_ENABLED`（#132，读者自建关注，见第 6 节「读者 watch」）、`ASK_PUBLIC_ENABLED`（#133，事件页的读者 Ask）。`ASK_PUBLIC_ENABLED`：只认 `"true"`；顶层和 `env.test` 都是 `"false"`。为 `"false"` 时事件页没有入口，`askAboutStory` 返回 403 `ask_disabled`。v1 不含 Finance（403 `section_not_allowed`，入口不显示）。
- 测试里安全阀一直关着；外部请求只连本地假服务。

## 2. 前端契约（使用者原文）

> Build a TanStack Start application with file-based TanStack Router routes, validated search params, route loaders, typed server functions, full-document SSR, and streaming. Keep server-only work behind explicit boundaries, choose the appropriate SSR mode per route, and target the deployment runtime without changing the application model.

落到本项目：

| 路由 | SSR 模式 | 数据 |
|---|---|---|
| `/`、`/s/$section`、`/e/$eventId`、`/digest/$section/$date`、`/w/$watch` | 完整 SSR，次要区块流式 | loader 调 `publication/` 的 server function |
| `/a/$articleId` | 完整 SSR | loader 调 `publication/` 的 server function（D1 + R2 `BODIES`，不调模型，不占预算） |
| `/rss/*.xml` | server route，纯文本 | `publication/`；板块 feed 的条目 `<link>` 是 `{SITE_URL}/a/{id}`，描述里带原始链接，guid 不变 |
| `/follow` | 完整 SSR | 读者建 watch 的表单与撤销表单；开关状态来自 `loadSiteShell`；写入只经 `server/reader-watch/` 的 POST server function；`READER_WATCH_ENABLED` 不是 `"true"` 时 404 |
| `/rss/p/{token}.xml` | server route，纯文本 | 读者的私有 RSS，只经 `server/reader-watch/`；见第 6 节「读者 watch」 |
| `/admin/*` | `ssr: 'data-only'` | `admin/` 的 server function，先过 Access 中间件 |

文章阅读页 `/a/$articleId`：

- **已批准**只用 `approvedArticleWhere` 判断，不另写条件；不满足 → 404。显示的正文版本是通过这个条件的那一行的 `articles.body_sha`（就是审核记录绑定的版本），R2 键 `bodies/{article_id}/{body_sha}.md`，不按"最新的 R2 对象"找。
- **显示范围**由信源的 `content_display`（第 9 节）决定，任何情况下都不显示超出范围的正文：
  - `full`：全文。只用于公共领域或允许转载的信源（政府来源、arXiv）；商业媒体用 `excerpt`。管理员确认对方允许转载后，才在后台把信源改成 `full`。
  - `excerpt`：从开头取完整的顶层块，合计不超过正文的 25%，也不超过 300 词；一块都放不下就不显示正文，不在段落中间截断。字数按读者实际看到的文字计（含图片 alt 文字）；渲染后再按可见文字核一次，超限就只显示摘要和原文链接。正文（或摘要）后面接 `Continue reading the original ↗`。
  - `summary`：只显示摘要，不读 R2。
  - `articles.body_kind` 不是 `full` 时（R2 里存的是 feed 摘要），按没有正文处理，不读 R2。
  - R2 没有对象或读取出错：显示摘要和原始链接，状态码仍是 200。
- 页头和页底都有原始链接 `Read the original at {source} ↗`。首页、板块页、事件页的文章卡片，标题链到 `/a/$id`，卡片上保留原始链接。
- `<link rel="canonical">` 指向原文 URL（URL 为空时不输出）；`<title>` 是 `{文章标题} — {SITE_NAME}`。读者可见的文字只用英文。
- Finance 文章页显示免责声明，有更正时显示更正（第 7 节）。
- **渲染**：只在服务端把 markdown 转成 HTML，基于现有的 markdown-it（`lib/` 的 markdown 净化），不加新依赖；markdown-it 不进客户端包，`components/**` 和 `routes/**` 拿到的是 HTML 字符串。
- **净化是唯一的防线**：CSP 的 `script-src` 带 `'unsafe-inline'`（`src/server/edge.ts`），挡不住注入的内联脚本。
  - 输出的 HTML 只能来自 markdown-it 自己生成的标记，加上表格外面的横向滚动容器。
  - 原始 HTML 一律不原样输出：`script`、`style`、`iframe`、`form` 等危险块整块删除；其他标签去掉，标签里的文字按纯文本转义输出。
  - 链接只允许 `http`/`https`，外链 `rel="nofollow noopener noreferrer"`（与现有规则同值）。
  - 图片只允许 `https`，加 `loading="lazy"` 和 `referrerpolicy="no-referrer"`；其他图片只留 alt 文字。只有 `full` 模式输出图片；`excerpt` 模式只输出文字块，图片只留 alt 文字，alt 文字计入 25% 和 300 词。理由：摘录模式下不转载商业媒体的图片。
- **排版**：正文宽度约 68 字符；标题、引用、代码、表格都有样式，表格和代码块在自己的容器里横向滚动；亮色和暗色都适用；375px 下页面不出现横向滚动。
- **证据锚点**：Inspect evidence 里每条引文都带一个链接，原来的原文链接同时保留。
  - 引文在阅读页的显示范围内（信源为 `full` 且 `body_kind='full'`）：链到 `/a/{id}#:~:text=…`，在站内高亮。
  - 其余情况（`excerpt` 信源的全部引文、`summary` 信源、没有正文）：链到原文 URL，同样带 `#:~:text=…`，旁边标 `Quote is in the full article at {source}`。`excerpt` 信源暂不判断引文是否落在摘录内，这样绝不显示超出版权范围的正文，事件页也不必读 R2；证据构建时存“是否在摘录内”的标记后再改成站内高亮（W2 跟进）。
  - 文本片段由引文去掉 markdown 记号后生成。

server function 的请求路径是 `/_serverFn/*`，不在 Access 保护的 `/admin*` 之下，公开页面也用它，所以不能整段交给 Access。后台 server function 的鉴权：先读 `Cf-Access-Jwt-Assertion` 请求头，没有就读 `CF_Authorization` cookie，两者做同样的完整校验（#4）。Zero Trust 应用要关闭 "Cookie Path Attribute"，否则 cookie 只在 `/admin` 下发送。

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
    reader-watch/           公开写入口：读者建 watch、撤销；私有 RSS 的读取层（#132）。写只限「公开写入口」表里的入口
    reader-ask/             公开写入口：事件页的读者提问和读回答（#133）。写只限「公开写入口」表里的入口
    db/                     Drizzle schema、查询
  pipeline/                 collect · body · analyze · group · generate · digest · watch · ask · discover · edgar · funding
  providers/                模型客户端、llm_calls 账本、预算、Jina、toMarkdown
  lib/                      纯函数：URL 规范化、时区、hash、markdown 净化
drizzle/migrations/         wrangler d1 migrations 执行
tests/
```

架构测试（`tests/architecture.test.ts`）强制四条：

1. `routes/**` 和 `server/publication/**` 不 import `pipeline/**` 或 `providers/**` 的模型模块。这保证"读者打开页面不触发模型调用"。
2. `routes/**` 读数据只经过 `server/publication/**`、`server/admin/**`，`server/reader-watch/**`（私有 RSS 的读取层，#132），或 `server/reader-ask/**`（#133）。`server/reader-watch/**` 和 `server/reader-ask/**` 的写只限下面「公开写入口」表里的入口。
3. `server/reader-watch/**` 和 `server/reader-ask/**` 不 import `pipeline/**`、`providers/**`、`server/admin/**`（类型 import 也不行；队列消息类型在测试里与 `AskMessage` 对齐）；公开入口的 R1 遍历在这两个目录停下（同 `server/publication/`）；`routes/**` 可以 import 这两个目录。
4. `server/reader-watch/**` 和 `server/reader-ask/**` 里每个 `createServerFn(` 都写成 `createServerFn({ method: "POST" })`。

**公开写入口**（#132 新增）：公开站能写数据库的只有下表的入口，其他公开代码只读。新增入口要先改本表（#24 的匿名反馈、#133 的读者 Ask 按同样规则加行）。

| 入口 | 文件 + 符号 | 写什么 |
|---|---|---|
| 读者建 watch | `src/server/reader-watch/api.ts` `createReaderWatch` | `watches` 一行，`owner_kind = 'reader'` |
| 读者撤销 watch | `src/server/reader-watch/api.ts` `revokeReaderWatch` | 该行的 `status`、`disabled_at`、`updated_at` |
| 私有 RSS 读取 | `src/routes/rss/p/{$token}[.]xml.ts` → `serveReaderFeed` | 该行的 `last_read_at`，每 6 小时最多一次 |
| 读者提问 | `src/server/reader-ask/api.ts` `askAboutStory` | `questions` 一行，`origin = 'public'`，`scope_type = 'event'`，`public_token_hash` = sha256hex(令牌)；再向 `Q_GENERATE` 发 `{ kind: "ask", questionId }` |
| 读者读回答 | `src/server/reader-ask/api.ts` `getStoryAnswer` | 不写（POST 只为令牌不进 URL）；只对 `origin = 'public'` 且令牌哈希相等的行返回 status、refusal、answer、已验证引用、unverified |

每个写入口都满足下面 6 条，读者 watch 的例外有两处，读者 Ask 的例外见本段末尾。第一，第 1 条和第 3 条不适用于「私有 RSS 读取」：它是 GET 路由（令牌在路径里，RSS 阅读器只发 GET，所以不经过 Origin 检查），只写该行的 `last_read_at`，每 6 小时最多一次，只对 `status = 'active'` 且 `disabled_at` 为空的读者行；响应头由 `src/server/edge.ts` 对 `/rss/p/` 下所有状态码统一设置（`Cache-Control: private, no-store`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`）。第二，第 3 条不适用于「读者撤销 watch」：撤销和私有 RSS 读取都不受 `READER_WATCH_ENABLED` 影响（第 6 节「读者 watch」的「开关」）。读者 Ask（#133）另有三处例外：

- 规则 3（自己的开关）不适用于「读者读回答」，同撤销。
- 规则 4（加盐 IP 哈希、按网络限额）：v1 例外。只有全站上限 `READER_ASK_LIMITS.publicPerDay = 30`（每 UTC 日一条 `INSERT … SELECT … WHERE count < 30`）。按网络限额（每网络每日 3 次）在 #166 补上；补上之前，`ASK_PUBLIC_ENABLED` 只在演示期间为 `"true"`。
- 规则 5（不调用模型）：`askAboutStory` 本身不调用模型；Ask 消费者调用，档位 `CALL_TIERS.adminAsk`、渠道 `gateway`。公开问题（`origin = 'public'`）跳过第 9 步补充抓取：只用本事件已批准文章的正文，每个问题最多一次 reason 调用。

1. 写入用 `method: "POST"` 的 server function，handler 里再检查一次请求方法是 `POST`（不依赖框架拒绝 GET）。请求经过 `src/server/edge.ts` 的 Origin 检查（对 GET、HEAD、OPTIONS 以外的方法生效）。Origin 检查之后，`handleFetch` 对 `/_serverFn/*` 的非安全方法请求（路径判断与 `handleFetch` 里已有的 `normalizePath(pathname)` 以 `/_serverfn` 开头相同）在解析之前检查请求体大小，这个上限对所有 server function 生效，不只是本表的入口：上限 `SERVER_FN_MAX_BODY_BYTES = 65536`（64 KB；后台有上限的输入字符串最长 1000 个字符，板块和信源配置 JSON 远小于 64 KB）；`Content-Length` 大于上限 → 413；`Content-Length` 不是合法的非负整数 → 400；`Content-Length` 缺失时不返回 411，而是按字节计数读 `request.body`，超过上限就取消读取并返回 413，没超过就把读到的字节用 `new Request(request, { body: bytes })` 交给 handler（浏览器或 HTTP/2 请求可能不带这个头，不能因此让所有后台写失败）。这两种拒绝的写法同 `forbidden()`：纯文本正文，413 是 `payload_too_large`，400 是 `bad_content_length`（这两个字符串是本契约定的），带安全头和 `no-store`，不调用 handler。GET 的 `/_serverFn/*` 和 `/_serverFn/*` 以外的 POST 不检查。检查必须放在 edge：`@tanstack/start-server-core` 的 `server-functions-handler.js` 里，`handleServerAction` 先解析请求体（JSON 用 `await request.json()`，表单用 `request.formData()`），再调用 `action(...)`；函数中间件和 handler 都在 `action` 里运行，所以后台的 Access 中间件也是在解析之后才拒绝。框架自己只限制 GET 的 `payload` 查询参数（`MAX_PAYLOAD_SIZE = 1e6`），不限制 POST 请求体。私有 RSS 是 GET：它唯一的写是 `last_read_at`，只延长令牌持有者自己那一行的寿命。
2. 输入用 zod 严格 schema（`.strict()`）校验，未知字段拒绝；长度和字符集写在第 6 节「读者 watch」。
3. 由自己的开关控制，开关只认 `"true"`。
4. 网络地址只取请求头 `cf-connecting-ip`，不读 `X-Forwarded-For` 或请求体；IPv4 取完整地址，IPv6 取前 64 位。库里只存 `sha256hex(IP_HASH_SALT + ":" + 用途 + ":" + UTC 日期 + ":" + 网络地址)`（假名化：持有盐的人可以对已知地址重算出同一个哈希），原始地址不写库、应用代码不写日志、不返回客户端。`IP_HASH_SALT` 缺失或为空就拒绝写入，不退回不加盐的哈希。
5. 不调用模型。
6. 超出上限时立即返回明确的错误码，不排队。

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

- 每篇文章在 `articles.stage` 记录阶段（`collected → body_ready → analyzed → grouped`，没入选的停在 `dropped`）和 `stage_updated_at`。任何写 `stage` 的语句同时写 `stage_updated_at = now`、`requeue_count = 0`。消息只带 `kind` 和 id。例外：`artifacts`、`evidence` 消息另带入队时的 `revision`，见第 6 节「去抖」。消费者按 `kind` 分发，从库里读状态，重复投递时直接跳过已完成的阶段。
- cron 每 10 分钟扫一次卡住的行（阶段超过 30 分钟没变），重新入队：`collected`、`body_ready` 回 `Q_INGEST`，`analyzed` 进 `Q_GROUP`。`dropped` 和 `grouped` 是终态。
- 入选文章由 #11 发进 `Q_GROUP`。DLQ 里的消息在后台查看和重放（见第 1 节 `Q_DLQ`）。
- 每个消费者按最坏情况的批次定 `max_batch_size`：一次调用共享 15 分钟墙钟时间和 CPU 上限。

## 6. 幂等、并发与预算

- **模型调用账本** `llm_calls`：`logical_key` 唯一，状态 `pending → in_flight → completed | failed | unknown`，带 `lease_expires_at`。租约过期的行可以用条件 `UPDATE` 接管；调用已发出、结果没落库的标 `unknown`，后台人工核账。承诺的是"不重复发起、可以恢复"，不是"恰好一次付费"。
- **预算预留**：调用前用一条条件语句预留 `UPDATE budgets SET reserved = reserved + ? WHERE day = ? AND channel = ? AND reserved + spent + ? + ?floor <= cap`。`?floor` 是这一档的地板（见下一条「gateway 五档」），非 `gateway` 渠道恒为 0。影响行数为 0 就不调用。AI Gateway 的 spend limit 是最终一致的，只作外层兜底（**已验证**："Spend limits are eventually consistent"）。
- **gateway 五档**（#116 新增）：`gateway` 的每日额度按调用用途分五档，档位挂在模型客户端上（`createModelClient` 的必填选项 `tier`），不挂在槽位、请求或 logical key 上，所以不改 `request_json`、`promptVersion` 和已有 key。
  1 = 预筛评分摘要、归组（含 `body` 的记账）；2 = Story Brief 与三档解释；3 = 论断与证据、后台 Ask；4 = 学习材料、板块编辑产品、管理员 watch；5 = 日报导语（日报、周报）、discover 与读者 watch 的判定（#132）。
  - **保留额**：第 1–4 档各有一个保留额 `R1..R4`（整数微美元，默认 `R1 = 500000, R2 = 400000, R3 = 200000, R4 = 100000`，写在 `DEFAULT_TIER_RESERVES`；`settings` 键 `budget.tier_reserves` 可选，有就覆盖，没有就用默认，不写迁移）。第 N 档的地板 `floor(N) = R1 + … + R(N−1)`，所以第 1 档的地板是 0，第 5 档的地板是 `R1 + R2 + R3 + R4`。
  - **准入**：第 N 档的调用只有在花完之后剩余额度仍不少于 `floor(N)` 时才放行，即上面那条 `reserved + spent + est + floor(N) <= cap`。前面的档因此总能先用完自己的份额。只作用于 `gateway`；`workers_ai`（embed）和 `jina` 各有自己的上限，不分档。
  - **账本**：`llm_calls.tier`（可空整数，#116 迁移 ADD COLUMN；迁移前的旧行为 NULL，后台显示 "untiered"）。后台 `/admin/ledger` 按 `tier` 汇总当天 `gateway` 的花费。
  - **被拒**：和现在一样，行写回 `failed`、`error = 'budget_exceeded'`，`failures` 不变，不花钱。工作排到以后：artifacts / evidence / watch 的到期扫描会重新入队，`generate` 消费者对 `BudgetExceededError` 直接 ack（不再重试进 DLQ）；归组消费者对它重置 `requeue_count`，文章保持 `analyzed` 等下一轮。
  - **已知行为**：日报导语（第 5 档）被拒时，当天日报不写导语，只显示已批准的标题和摘要，不会第二天补写。生产没有 `digest.timezone`，默认 UTC，所以日报在预算日开始（00:00 UTC）时生成，此时第 5 档放行。改成别的时区后，日报会在预算日中途生成，导语可能被第 5 档拒掉。
- **归组**：`Q_GROUP` 并发 1，批内 `for…of` 顺序处理，不用 `Promise.all`。候选事件 = Vectorize 召回 ∪ D1 里 30 分钟内新建的事件（Vectorize 索引是异步的）。`event_articles.article_id` 唯一。
- **预算渠道**：`workers_ai`、`gateway`、`jina`。v1 不设独立的 `ask` 预算渠道（#133 验收 2 记为演示期偏离）：公开 Ask 与后台 Ask 共用 gateway 上限，档位 `adminAsk`。全站每日最多 30 问 × `ASK_QUESTION_MAX_COST_MICROS`。独立的 fail-closed `ask` 渠道在 #133 后续切片实现。
- **事件 revision**：什么时候加 1、三种写法和全部写路径见本节下面的「事件 revision」。产物键 = `(event_id, type, audience, input_revision, prompt_version, model)`，只有 `input_revision` 等于当前 revision 时才写入，避免旧任务覆盖新结果。
- **多表更新**用 D1 `batch()` 一次提交。
- **正文**按 `bodies/{article_id}/{sha256}.md` 存，不覆盖；论断证据引用的是具体版本。采集时 feed 自带的 `content:encoded` 原样存在 `feed/{sha256hex(canonical_url)}.html`（#5 写，在插入 `articles` 之前写，每次抓取覆盖写），它是正文抓取第 0 档的原始输入，不是正文版本；#6 按 `canonical_url` 算出键去读，有就用。

本节下面用的别名：`a` = `articles`，`e` = `events`，`ea` = `event_articles`，`art` = `event_artifacts`，`c` = `claims`，`ce` = `claim_evidence`。SQL 里比较可能为 NULL 的值一律写 `IS` / `IS NOT`。片段里的 `?articleId` 这类参数名只是说明，实现用编号参数 `?1`、`?2`…。标「#113 新增」的符号和列现在还不存在，由 #113 实现。

### 事件 revision

事件的**已批准输入** = 事件里每篇已批准文章（`APPROVED_ARTICLE_SQL`）的五元组 `(article_id, body_sha, reviews.analysis_id, title_override, summary_override)` 的集合。已批准输入变化时，`events.revision + 1`，并写 `updated_at = now`。论断审核（批准或拒绝）一律不加 1。只有三种写法：

| 写法 | 什么时候用 | SET |
|---|---|---|
| **增长** | 只增加了已批准文章 | `revision = revision + 1, updated_at = ?n, ${pendingSinceSetSql(n)}` |
| **变更** | 去掉了已批准文章，或已批准文章的分析行、正文、改写变了 | `revision = revision + 1, withdrawn_through = revision, updated_at = ?n, ${pendingSinceSetSql(n)}` |
| **只撤下** | 输入还没变，但旧版本必须立刻下线（重新分析重置） | `withdrawn_through = revision`。不加 1，不写 `updated_at`，不写 `<kind>_pending_since` |

- 每种写法都和触发它的写入放在同一个 `batch()`，用 `changes() = 1` 或 `EXISTS(…)` 串起来：触发写入没生效，就不加 1。
- `events.withdrawn_through`（#113 新增，`integer NOT NULL DEFAULT 0`）只增不减，且 `withdrawn_through <= revision`。三种写法都保持这两条：增长不动它；变更写成旧 `revision`；只撤下写成当前 `revision`。SQLite 的 `UPDATE … SET revision = revision + 1, withdrawn_through = revision` 右边读的是旧值（**推断**，#113 用测试证明）。
- 函数：#113 在 `src/server/db/events.ts` 新增 `growRevisionStatement`、`changeRevisionStatement`、`withdrawStatement`，签名同 `revisionBumpStatement`，替换它。`conditionalReviewRevisionBumpStatement` 保留，加参数 `analysisId: number | null`，按下表第 1–4 行扩展条件。
- `pendingSinceSetSql(n: number): string`（#113 新增，`src/server/db/events.ts`）返回共享 SET 片段：`artifacts_pending_since = COALESCE(artifacts_pending_since, ?n), evidence_pending_since = COALESCE(evidence_pending_since, ?n)`。`n` 是调用方语句里绑定 `now` 的参数序号（上表的 `?n` 是同一个参数）；片段不增加参数，调用方的参数顺序不变。每一条加 1 语句都插值它：现有的加 1（`src/server/db/events.ts` 2 处、`src/pipeline/group/group-article.ts` 2 处、`src/pipeline/evidence/primary.ts` 3 处；`reanalyzeArticle` 那 1 处按第 7 行改为只撤下）、下表新增的加 1、下面第 9/10 行共用的语句、「读者看到的分析行」迁移里的变更。不写内联副本。
- 下表之外不许出现 `revision = revision + 1`。#113 加扫描测试，按文件固定加 1 语句和 `pendingSinceSetSql(` 的引用次数（同 `tests/approved-definition.node.test.ts` 的 `EXPECTED_USES`）。
- 后台的审核写入不发生成消息。`artifacts`、`evidence` 消息只由 cron 的 `enqueueDueEvents` 发（见「去抖」）。

写路径（全部 16 条）：

| # | 文件 + 符号 | 触发 | 写法 | 条件 |
|---|---|---|---|---|
| 1 | `decideReview`（`src/server/admin/ops.ts`）→ `conditionalReviewRevisionBumpStatement` | 批准未批准的文章 | 增长 | 加 1、`UPDATE event_articles`、reviews upsert 三条都带候选条件 `${CANDIDATE_ANALYSIS_ID_SQL} IS ?analysisId AND a.body_sha = ?bodySha`。不满足时三条都是 0 行，返回 409，revision 不动，旧版本不撤下 |
| 2 | 同上 | 批准已批准的文章，且 `${CANDIDATE_ANALYSIS_ID_SQL} IS NOT reviews.analysis_id` | 变更 | 后台批准新分析的唯一入口。候选条件同第 1 行。加 1 排在 reviews upsert 之前，比较的是 upsert 前的 `analysis_id` |
| 3 | 同上；`retractArticle` 调用它 | 拒绝已批准的文章 | 变更 | 不检查候选，只检查 `a.body_sha = ?bodySha`：拒绝的对象是 `(article_id, body_sha)`。拒绝写 `analysis_id = NULL` |
| 4 | 同上 | 拒绝未批准的文章 | 不加 1 | 不检查候选 |
| 5 | `updateArticleOverride`（`ops.ts`） | 改标题或摘要 | 变更 | 只在文章已批准且值真的变了时：文章 UPDATE 加 `WHERE title_override IS NOT ?1 OR summary_override IS NOT ?2`，加 1 语句带 `changes() = 1 AND ${APPROVED_ARTICLE_SQL}` |
| 6 | `changeArticleIndustry`（`ops.ts`） | 改板块 | 不加 1；409 + 守卫 | batch 外查到文章在事件里就 409（保留）。batch 里每条语句（改 `industry_id`、删 auto 批准）都加 `AND NOT EXISTS (SELECT 1 FROM event_articles WHERE article_id = ?articleId)`，改 `industry_id` 那条 0 行就返回 409。删掉 Finance 分支里的 `revisionBumpStatement`：守卫成立时文章不在任何事件里 |
| 7 | `reanalyzeArticle`（`ops.ts`） | 重新分析重置 | 只撤下 | 只在文章已批准时：`changes() = 1 AND ${APPROVED_ARTICLE_SQL}`。新分析获批时才加 1（第 2、10 行）；新分析一直没落库时，由审核队列第 3 项兜住（「读者看到的分析行」） |
| 8 | `analyzeArticle` 提交（`src/pipeline/analyze/analyze.ts`），`review` 模式 | 新分析落库 | 不加 1 | 新行只是候选，进审核队列 |
| 9 | 同上，`auto` 模式（`effectivePublishMode(row) === "auto"`，只是预判） | 文章已在事件里、当前正文还没有批准记录，新分析被 auto 批准 | 增长 | auto 批准改成 `INSERT … SELECT … FROM articles a JOIN industries i ON i.id = a.industry_id WHERE <现有条件> AND i.publish_mode = 'auto' AND lower(trim(i.slug)) IS NOT 'finance' AND changes() = 1 ON CONFLICT (article_id, body_sha) DO UPDATE SET analysis_id = excluded.analysis_id WHERE reviews.decision = 'approved' AND reviews.analysis_id IS NOT excluded.analysis_id`，`analysis_id` = 同一 batch 刚插入的行。板块在提交时用 SQL 重新判断：分析开始后，管理员可能把未归组的文章改到 Finance 或 `review` 板块（`changeArticleIndustry` 只删已有的 auto 批准，这时还没有）。加 1 用下面的共用语句 |
| 10 | 同上，`auto` 模式 | 文章当前正文已批准，新分析落库 | 变更 | 同一条 upsert 走 `DO UPDATE`，`analysis_id` 换成新行；已有的拒绝不推翻。加 1 用下面的共用语句。Finance 和 `review` 板块走不到这里：以提交时第 9 行的 SQL 板块条件为准，`effectivePublishMode` 只是预判 |
| 11 | `groupArticle`（`src/pipeline/group/group-article.ts`）并入分支、新建分支 | 已批准文章进事件 | 增长 | 不变：`changes() = 1` 和 `EXISTS(已批准)` |
| 12 | `src/pipeline/evidence/primary.ts`，一手文件挂进事件（2 处） | 一手文件挂进事件 | 增长 | 不变：CAS / `changes() = 1` |
| 13 | 同文件，新建的一手文章自动批准并挂进事件 | 一手文章进事件 | 增长 | 补 `changes() = 1`（前一条是 `event_articles` INSERT）。现在没有任何条件 |
| 14 | `ingestCompanyFilings`（`src/pipeline/edgar/ingest.ts`） | EDGAR 正文变了 | 变更 | 只在旧正文或新正文任一有批准记录时：正文从 h1 换成 h2、再换回 h1 时，h1 的旧批准重新生效，也是变更。upsert 改进 `batch()`，在它之前放 `changeRevisionStatement`，条件 `(SELECT body_sha FROM articles WHERE canonical_url = ?3) IS NOT ?11`（`?3` = `canonical_url`，`?11` = 新 `body_sha`）且 `EXISTS (SELECT 1 FROM reviews r JOIN articles a ON a.id = r.article_id WHERE a.canonical_url = ?3 AND r.body_sha IN (a.body_sha, ?11) AND r.decision = 'approved')`（`a.body_sha` 是 batch 执行前的旧正文）。实现：#113 |
| 15 | `decideReview` 里重算 `financial_facts.superseded_by` | 批准或拒绝 EDGAR 修订文件 | 变更 | 对包含原文件文章的事件做变更。见「已知缺口」第 1 条。实现：W4 EDGAR 跟进 |
| 16 | `src/pipeline/body/body.ts` 的 `force` 分支 | 后期重抓正文，换 `body_sha` | 变更 | 规则同第 14 行（旧正文或新正文任一有批准记录）。现在没有调用方传 `force: true`，#113 不改；没有实现 issue，见「已知缺口」第 3 条 |

第 9、10 行共用的加 1 语句：一条语句同时判别和加 1，不靠 `changes()` 区分 insert 和 update（两者的 `changes()` 都是 1）。

```sql
UPDATE events
SET revision = revision + 1,
    withdrawn_through = CASE WHEN EXISTS (
      SELECT 1 FROM reviews r
      WHERE r.article_id = ?1 AND r.body_sha = ?2 AND r.decision = 'approved'
    ) THEN revision ELSE withdrawn_through END,
    updated_at = ?3, ${pendingSinceSetSql(3)}
WHERE id = (SELECT event_id FROM event_articles WHERE article_id = ?1)
  AND <upsert 一定会生效>
```

参数顺序：`?1` = 文章 id，`?2` = 分析用的 `body_sha`，`?3` = `now`，`?4` = `analysis_generation`，`?5` = 本次的 `prompt_version`（`analysed`）。

- `EXISTS` 为真 = 当前正文已有批准记录 = 变更（第 10 行）；为假 = 增长（第 9 行）。
- 位置：batch 的第一条，排在 stage CAS 之前，只在 `approve` 为真时加入。现在的 batch 是「stage CAS → `INSERT INTO analyses … WHERE changes() = 1` → reviews upsert `… AND changes() = 1`」一条链；加 1 插在中间，upsert 的 `changes()` 就会读到加 1 的行数。
- `<upsert 一定会生效>` 用 batch 执行前的状态写成四条，都成立时后面三条语句按链依次生效（**推断**，#113 用测试证明）：
  - `EXISTS (SELECT 1 FROM articles WHERE id = ?1 AND stage = 'body_ready' AND body_sha = ?2 AND analysis_generation = ?4)`（stage CAS 的同一组条件）；
  - `NOT EXISTS (SELECT 1 FROM analyses WHERE article_id = ?1 AND prompt_version = ?5)`；
  - `NOT EXISTS (SELECT 1 FROM reviews WHERE article_id = ?1 AND body_sha = ?2 AND decision = 'rejected')`；
  - `EXISTS (SELECT 1 FROM articles a JOIN industries i ON i.id = a.industry_id WHERE a.id = ?1 AND i.publish_mode = 'auto' AND lower(trim(i.slug)) IS NOT 'finance')`（第 9 行 upsert 的板块条件）。少了这一条，板块不再是 auto 时 upsert 不生效，revision 却加了 1。

实现：#113（第 15、16 行除外）。第 9、10 行的板块条件先写测试，按「分析开始，读到 auto 配置 → 管理员把未归组的文章改到 Finance → 分析提交」的顺序复现，提交后不得有 `reviewer = 'auto'` 的批准记录。

### 已发布版本

事件产物和论断对读者可见，要同时满足：状态是 `published`；`input_revision` 落在窗口 `(events.withdrawn_through, events.revision]` 内。同一 `(type, audience)` 有多行可见时，只显示 `input_revision` 最大的一行。论断按 revision 整组显示：取窗口内有可公开论断（「论断守卫」）的最大 revision，只显示这一 revision 的论断。

- 已批准输入只增加时（「事件 revision」的增长），`withdrawn_through` 不变，旧版本继续显示，直到新 revision 的版本被批准。
- 拒绝或撤下已批准文章、人工改写已批准文章、批准新的分析行、正文变化、重新分析，都在同一个 `batch()` 里把 `withdrawn_through` 推到旧 revision 或当前 revision，旧版本立刻不可见。
- 改板块要立刻撤下旧版本（第六轮），由「在事件里的文章不能改板块」满足：`changeArticleIndustry` 返回 409，batch 里每条语句都带 `NOT EXISTS (event_articles)` 守卫，所以改了板块的文章不在任何事件里，没有已发布版本要撤下，第六轮的要求已经满足。
- `revision_diff` 是时间线历史，不受窗口限制，仍按「该 revision 有已批准文章」显示。
- 窗口为空（`withdrawn_through = revision`）时，事件页只显示已批准文章，不显示任何产物和论断。

`PUBLISHED_ARTIFACT_SQL`（#113 新增，`src/server/publication/events.ts`，别名 `art`、`e`）：

```sql
art.status = 'published'
AND art.type IS NOT 'revision_diff'
AND art.input_revision > e.withdrawn_through
AND art.input_revision <= e.revision
AND NOT EXISTS (
  SELECT 1 FROM event_artifacts n
  WHERE n.event_id = art.event_id AND n.type = art.type AND n.audience = art.audience
    AND n.status = 'published'
    AND n.input_revision > art.input_revision AND n.input_revision <= e.revision
)
```

论断的可见 revision（`getEventEvidence` 用）。子查询里的别名也是 `c`，内层遮蔽外层，`VERIFIED_CLAIM_SQL` 不用改别名：

```sql
c.input_revision = (
  SELECT max(c.input_revision) FROM claims c
  WHERE c.event_id = e.id AND c.status = 'published'
    AND c.input_revision > e.withdrawn_through AND c.input_revision <= e.revision
    AND c.claim_text NOT LIKE '[%]'
    AND ${VERIFIED_CLAIM_SQL}
)
```

- `getEvent`（`src/server/publication/events.ts`）的产物查询：别名改成 `art`，条件换成 `${PUBLISHED_ARTIFACT_SQL}`。`getEventEvidence`（`src/server/publication/evidence.ts`）换成上面的可见 revision 条件。
- 迁移回填 `withdrawn_through = max(revision - 1, 0)`，让部署后的窗口等于 `{revision}`。
- `reviewArtifact`、`listPendingArtifacts` 不变：只审当前 revision 的 `pending_review`。

实现：#113。

### 去抖

`artifacts` 和 `evidence` 的到期条件，在 #107 的终态检查之外再加一条：`e.updated_at <= now - ARTIFACTS_DEBOUNCE_MS` **或** `e.<kind>_pending_since <= now - ARTIFACTS_MAX_WAIT_MS`。

- `ARTIFACTS_DEBOUNCE_MS = 30 * 60 * 1000`，`ARTIFACTS_MAX_WAIT_MS = 2 * 60 * 60 * 1000`，都从 `src/pipeline/due-events.ts` 导出（#113 新增）。
- 这两项取代第六轮「只看 `updated_at` 距今 ≥ 30 分钟」的写法（`docs/design/decisions.md` 第六轮「去抖」）：只看静默时间时，一直有人审核的事件永远不到期。这一改动记入第八轮决定。
- `events.artifacts_pending_since`、`events.evidence_pending_since`（#113 新增，`integer`，可空）= 该类上次写终态标记之后第一次加 1 的时刻；NULL = 该类上次写终态标记之后没有加 1。第二项是最长等待：从第一次还没生成的加 1 算起，最长 2 小时必到期一次。
- 去抖只是 `DUE_KINDS.artifacts` 和 `DUE_KINDS.evidence` 的附加条件。#107 的不变量不变：到期 = 当前 revision 没有终态（`doneSql`）；排序 = `<kind>_scheduled_at ASC, id ASC`；不引入时间窗选择。`watch` 不去抖。
- **一次审核会话**：同一事件上一串 revision 加 1，相邻两次相隔不到 30 分钟。会话里加 1 N 次，cron 在最后一次加 1 后 30 分钟起，或会话第一次加 1 后满 2 小时起（先到者），开始把事件入队，生成当时 revision 的版本；到该类写终态标记之前，同一 revision 每轮 cron 都可能再次入队（见下面「已知行为」）。cron 每 10 分钟跑一次（`wrangler.jsonc` `"crons": ["*/10 * * * *"]`），所以实际延迟是 30–40 分钟。
- `artifacts`、`evidence` 消息带入队时的 `revision`（`src/pipeline/messages.ts` 的 `ArtifactsMessage`、`EvidenceMessage`）。`generateEventArtifacts`、`generateEventEvidence` 在输入快照里读到的 `e.revision` 不等于消息的 `revision`，或消息没有 `revision`，就跳过：不写任何终态（不调用 `markArtifactsEvaluated`，不写任何 `claims` 行，包括 `EVIDENCE_TERMINAL_SQL` 的终态行），不调用模型，下一轮 cron 再判断。跳过时 `<kind>_pending_since` 保留，下一轮 cron 按新的 revision 重新入队。可重试错误（#107）导致同一 revision 再次入队，不算第二次触发。
- 即时发送全部删除：`handleGroupBatch`（`src/pipeline/group/consumer.ts`）的 `artifacts`、`evidence` 两条，`src/pipeline/evidence/primary.ts` 的 `qArtifacts?.send`、`qEvidence?.send`。`handleGroupBatch` 的 `watch` 保留。

写入与清空：

| 列 | 谁写 |
|---|---|
| `events.updated_at` | 只有 revision 加 1 和 `INSERT INTO events`。只撤下不写 |
| `<kind>_pending_since` 写入 | 只在 revision 变大时写。每条加 1 经 `pendingSinceSetSql(n)` 写 `COALESCE(…, ?n)`，只记终态标记之后第一次加 1。`revision = 0` 的 `INSERT INTO events`（`groupArticle` 新建分支）不写；`revision >= 1` 的 INSERT 等于一次加 1，两列写 `now`。只撤下不写 |
| `<kind>_pending_since` 清空 | 只在该类写终态标记时，条件是 `revision = 标记的 revision`。artifacts：`markArtifactsEvaluated`（`src/pipeline/artifacts/build.ts`）的 UPDATE 在 SET 里加 `artifacts_pending_since = CASE WHEN revision = ?2 THEN NULL ELSE artifacts_pending_since END`（`?2` = 标记的 revision），WHERE 不变。evidence：写 `EVIDENCE_TERMINAL_SQL` 终态行的同一个 `batch()` 末尾加 `UPDATE events SET evidence_pending_since = NULL WHERE id = ?1 AND revision = ?2 AND EXISTS (SELECT 1 FROM claims WHERE event_id = ?1 AND input_revision = ?2 AND claim_text IN (${EVIDENCE_TERMINAL_SQL}))`（`?1` = 事件 id，`?2` = 标记的 revision）。标记写入时 revision 已经变大，就不清空，新的加 1 不丢。`enqueueDueEvents` 不清空（取代第三批裁决的「入队时清空」）。`watch` 不加 |
| `<kind>_scheduled_at` | 只有 `enqueueDueEvents` |

`enqueueDueEvents` 的改法：`DUE_KINDS` 的值类型加可选字段 `debounce?: { quietMs: number; maxWaitMs: number; pendingColumn: string }`，`artifacts`、`evidence` 设置，`watch` 不设。WHERE 在 `NOT (${doneSql})` 后加 `AND (?2 IS NULL OR e.updated_at <= ?4 - ?2 OR e.${pendingColumn} <= ?4 - ?3)`，绑定 `quietMs ?? null`、`maxWaitMs ?? null`、`now`；`watch` 绑定 NULL，不插值 `pendingColumn`，行为不变。SELECT 改成 `e.id, e.revision`，消息写成 `{ kind, eventId, revision }`。

迁移回填与部署前计数（#113 执行，结果贴进 #113 PR）：每一类各一次，条件用 `enqueueDueEvents` 的完整到期条件，evidence 写法相同。

```sql
UPDATE events AS e SET artifacts_pending_since = e.updated_at
WHERE e.revision > 0
  AND EXISTS (
    SELECT 1 FROM event_articles ea JOIN articles a ON a.id = ea.article_id
    WHERE ea.event_id = e.id AND ${APPROVED_ARTICLE_SQL}
  )
  AND NOT (${DUE_KINDS.artifacts.doneSql})
-- evidence：evidence_pending_since、DUE_KINDS.evidence.doneSql
-- 部署前计数：SELECT count(*) FROM events e WHERE <同上条件>
```

- 「不超过 2 小时的会话只触发一次」的前提：每次加 1 都写 `updated_at` 和 `pendingSinceSetSql(n)`；`artifacts`、`evidence` 消息只由 cron 发；旧消息不生成新 revision；`generateEventArtifacts` 生成完写 `artifacts_evaluated_revision = revision`，到下一次加 1 前不再到期；`<kind>_pending_since` 只在该类写终态标记时清空；生成器对 `(event, revision, 类型)` 幂等（下面第二条「已知行为」）。
- 代价：`auto` 板块的首次产物延迟 30–40 分钟（D3 已接受）。
- **已知行为**：事件里最后一篇已批准文章被拒后，事件不再到期，但这次变更写下的 `<kind>_pending_since` 不清空。事件下一次重新到期时，第一次加 1 经 `COALESCE` 保留旧值，最长等待立刻成立，这一次跳过 30 分钟去抖。上限：每次「不到期 → 重新到期」最多提前触发一次，最多多生成一次。不加清空机制。
- **已知行为**：同一 revision 会被重复入队。到期之后、写终态标记之前，cron 每轮都重发这个事件（`enqueueDueEvents`，`src/pipeline/due-events.ts:50-84`，现状如此）。前提是生成器对 `(event, revision, 类型)` 幂等：evidence 已有 `already_exists`（`src/pipeline/evidence/build.ts:243`）；artifacts 逐类型跳过已存在的产物（`src/pipeline/artifacts/build.ts:674-683`，INSERT 带 `ON CONFLICT … DO NOTHING`）。#113 给 artifacts 的幂等补一个测试：同一 `(event, revision)` 跑两次，第二次对已有产物的类型不调用模型、不新增产物行。
- **已知行为**：超过 2 小时的审核会话可能入队不止一次。每次写终态标记后，会话里下一次加 1 重新开始计时，满 2 小时再次到期。上限：最长等待每 2 小时最多触发一次；会话结束后，静默 30 分钟再触发一次。

实现：#113。

### 论断守卫

论断只有满足 `VERIFIED_CLAIM_SQL` 才能批准、才能公开、才能进入产物的输入：至少有一条证据 `verified = 1` 且 `stance = 'support'`，这条证据引用的文章是事件里的已批准文章，并且证据的 `body_sha` 等于文章当前的 `body_sha`。

`VERIFIED_CLAIM_SQL`（#113 新增，`src/server/publication/evidence.ts`，别名 `c`）：

```sql
EXISTS (
  SELECT 1 FROM claim_evidence ce
  JOIN articles a ON a.id = ce.article_id AND a.body_sha = ce.body_sha
  JOIN event_articles ea ON ea.article_id = a.id AND ea.event_id = c.event_id
  WHERE ce.claim_id = c.id AND ce.verified = 1 AND ce.stance = 'support'
    AND ${APPROVED_ARTICLE_SQL}
)
```

- `ce.stance = 'support'`：`evaluateClaimConsensus`（`src/pipeline/evidence/verify.ts`）只把 verified support 算作支持，守卫与共识规则一致。
- `verified` 只由 `generateEventEvidence` 的 `INSERT INTO claim_evidence` 写一次：对模型给出的每条引文，读 R2 `bodies/{article_id}/{body_sha}.md`（`body_sha` 是生成时这篇已批准文章的当前正文），用 `verifyQuoteInBody` 在正文里找引文，找到写 1，找不到写 0。之后不更新。正文换了版本，旧证据自动失效（`a.body_sha = ce.body_sha`），不需要改写。
- 守卫在批准时和读取时各查一次，以读取时的结果为准：文章可能之后被撤下或换正文。

| 读写方 | 契约 |
|---|---|
| `reviewClaim`（`ops.ts`） | 语句改成 `UPDATE claims AS c …`，批准时加 `AND (?1 IS NOT 'published' OR ${VERIFIED_CLAIM_SQL})`；拒绝不受限 |
| `listPendingClaims`（`ops.ts`） | 返回每条论断的守卫结果，后台对不满足的论断禁用「批准」 |
| 事件级一键批准（#113 新增） | 只批准满足守卫的论断，其余保持 `pending_review` |
| `getEventEvidence` | WHERE 加 `AND ${VERIFIED_CLAIM_SQL}`。现在零证据论断也公开 |
| `getEvent` 的撤稿论断查询 | 改成 `NOT ${VERIFIED_CLAIM_SQL}`。现在零证据论断不算撤下 |
| `generateEventArtifacts` 读论断作产物输入 | 加 `AND ${VERIFIED_CLAIM_SQL}` |
| `src/pipeline/evidence/diff.ts` 读论断 | 加 `AND ${VERIFIED_CLAIM_SQL}` |
| `generateEventEvidence` `INSERT INTO claims` 的状态 | 不变：`auto` 且共识不是 `unverified` 时直接 `published`，这时守卫已成立 |

**已知行为**：论断审核不改 revision。产物只读 `input_revision` = 当前 revision 的已发布论断（`generateEventArtifacts`，`src/pipeline/artifacts/build.ts:233-239`）。所以 R 的产物生成之后才批准的论断，不进入任何产物；到 R+1，证据重新抽取，新论断要重新审核。被拒的论断在被拒之前一直是 `pending_review`，从未发布，也从未进过产物输入（`reviewClaim` 只改 `status = 'pending_review'` 的论断）。

实现：#113。

### 读者看到的分析行

读者看到的分析行 = 文章当前正文的批准记录里写的那一行：`reviews.analysis_id`（#113 新增，`integer`，可空，不加外键）。凡是显示读者看到或将会看到的内容的页面和生成器，都用 `READER_ANALYSIS_ID_SQL`，论断审核页也算：公开页、RSS、日报、产物、证据、后台的非审核页面和论断审核页（`listPendingClaims`）。没有批准记录，或 `analysis_id` 为 NULL，就不用任何分析行，文字退回到人工改写，再退回到信源自己的标题和摘要。

待审的分析行 = `CANDIDATE_ANALYSIS_ID_SQL`：最新一行，`primary_tracker` 行排在 Jev 行后面。只有文章审核队列（`listPendingArticles`）和归组用它。

新分析落库不改变读者文本（`auto` 板块除外，见「事件 revision」第 10 行）。管理员批准时，`decideReview` 把 `analysis_id` 写成审核页上显示的那一行；在那之前读者继续看到旧的已批准行。

两个片段（#113 新增，`src/server/publication/articles.ts`，别名 `a`）：

```sql
-- READER_ANALYSIS_ID_SQL
(SELECT r.analysis_id FROM reviews r
 WHERE r.article_id = a.id AND r.body_sha = a.body_sha AND r.decision = 'approved')

-- CANDIDATE_ANALYSIS_ID_SQL
(SELECT x.id FROM analyses x WHERE x.article_id = a.id
 ORDER BY (x.prompt_version = 'primary_tracker') ASC, x.created_at DESC, x.id DESC LIMIT 1)
```

`reviews (article_id, body_sha)` 唯一，第一个片段最多一行。用法：`LEFT JOIN analyses an ON an.id = ${READER_ANALYSIS_ID_SQL}`。

- 换成 `READER_ANALYSIS_ID_SQL`：`CARD_FROM` 和首页更正查询（`src/server/publication/articles.ts`）、`generateEventArtifacts`、`generateEventEvidence`、`src/pipeline/digest/build.ts` 6 处、`src/server/publication/digests.ts`、`getEventEvidence`、`listPendingClaims`。
- 换成 `CANDIDATE_ANALYSIS_ID_SQL`：`groupArticle` 读文章（归组用最新的分析，文章这时通常还没批准）；`listPendingArticles` 显示候选，同时显示读者行作对比。
- 不在本规则内：`groupArticle` 的 origin 查询（`prompt_version = 'primary_tracker'`）；`getArticle`（后台文章详情）列出全部分析行，是历史视图。

写 `reviews.analysis_id`：

| 写入方 | 契约 |
|---|---|
| `decideReview` | 参数加 `analysisId: number \| null`（审核页显示的候选）。批准：reviews upsert 写 `analysis_id = ?analysisId`，候选条件同「事件 revision」第 1 行，不满足就 0 行，返回 409。拒绝：只查 `body_sha`，写 `analysis_id = NULL` |
| `analyzeArticle` 自动批准 | `analysis_id` = 同一 batch 刚插入的行（`SELECT id FROM analyses WHERE article_id = ?1 AND prompt_version = ?analysed`）；upsert 形状见「事件 revision」第 9、10 行 |
| `src/pipeline/evidence/primary.ts` 自动批准 | `analysis_id` = 该文章的 `primary_tracker` 行；先插分析行，再插批准记录 |

审核队列条件（`listPendingArticles`），三项取 OR：

```sql
-- 1 未审：
(a.stage IN ('analyzed','grouped')
 AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.article_id = a.id AND r.body_sha = a.body_sha))
-- 2 新分析待批（含重新分析判为不入选）：
OR (${APPROVED_ARTICLE_SQL} AND ${CANDIDATE_ANALYSIS_ID_SQL} IS NOT ${READER_ANALYSIS_ID_SQL})
-- 3 重新分析卡住、事件已撤下：
OR (a.stage = 'body_ready' AND a.requeue_count >= 3 AND ${APPROVED_ARTICLE_SQL}
    AND EXISTS (SELECT 1 FROM event_articles ea JOIN events e ON e.id = ea.event_id
                WHERE ea.article_id = a.id AND e.withdrawn_through = e.revision))
```

- 第 2 项不限 stage：重新分析把文章判成 `dropped`（新行 `selected = 0`）时也进队列，不自动撤稿。批准 = 采用新行（读者文本退回到人工改写或信源摘要）；拒绝 = 下线。
- 第 3 项的「卡住」与 `listStuckArticles` 同一定义：`stage = 'body_ready' AND requeue_count >= 3`（3 = `MAX_REQUEUES`，`src/pipeline/requeue.ts`）。条目标「重新分析卡住」，提供两个动作：重新分析（`reanalyzeArticle`，`expectedStage = 'body_ready'`）、拒绝（`decideReview` rejected）。在这一项上批准不改变任何东西：候选仍是旧行，「事件 revision」第 2 行不触发（**推断**）。
- 读者文本只在三种写入下改变，都是变更：批准记录的 `analysis_id` 变了（「事件 revision」第 2、10 行）；人工改写（第 5 行）；下面的一次性回填。产物的输入和读者看到的是同一行，所以产物不会基于未批准的分析生成。

迁移回填：对 `decision = 'approved'` 的每一行 `r`，`analysis_id` = 批准时审核页的选法（`listPendingArticles` 现在的写法：最新一行 `selected = 1`），限定在批准时刻之前：

```sql
(SELECT x.id FROM analyses x
 WHERE x.article_id = r.article_id AND x.selected = 1 AND x.created_at <= r.created_at
 ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
```

- `r.created_at` 是最后一次决定的时刻：`decideReview` 的 upsert 每次覆盖它。`analyzeArticle` 的 auto 批准与分析行用同一个 `now`，`<=` 包含它。
- 风险（**推断**）：`analyses.created_at` 是分析开始的时刻，不是提交的时刻。批准时正在跑、批准后才提交的分析会被算进来。这个比较只用于一次性回填，运行时规则用 `reviews.analysis_id`。

部署前只读计数（#113 执行，结果贴进 #113 PR，先给使用者看再合并）：

- (a) 有更新候选行的文章数：已批准、且 `${CANDIDATE_ANALYSIS_ID_SQL} IS NOT <回填行>`。这些文章部署后进审核队列第 2 项，属于正确行为。
- (b) 回填行与当前读者行不同的文章所在的事件数：已批准、且 `<回填行> IS NOT (SELECT id FROM analyses WHERE article_id = a.id ORDER BY created_at DESC, id DESC LIMIT 1)`（`CARD_FROM` 现在选中的行）的文章，按 `event_articles` 去重数事件。
- (b) > 0 时，迁移在回填之后对这些事件做变更（`revision = revision + 1, withdrawn_through = revision, updated_at = ?n, ${pendingSinceSetSql(n)}`，`?n` = 迁移时刻）。这些事件之后会按去抖重新生成产物和论断，会花模型费用：dry-run 计数里同时列出事件 id，使用者确认后再合并 #113（合并即部署、即执行迁移）。

实现：#113。

### 已知缺口

1. **修订获批后原事件不加 1**（「事件 revision」第 15 行，第七轮 EDGAR 一节）：批准或拒绝 EDGAR 修订文件后，`financial_facts.superseded_by` 变了，但包含原文件的事件不加 1。实现：W4 EDGAR 跟进。
2. **跨事件依赖**：事件 E2 的同比数字取自事件 E1 的 filing；E1 的文章后来被拒，E1 加 1，E2 不加 1，E2 的产物不撤下。实现：W4 EDGAR 跟进。
3. **后期重抓正文不加 1**（「事件 revision」第 16 行）：`src/pipeline/body/body.ts` 的 `force` 分支换 `body_sha` 时不加 1。现在没有调用方传 `force: true`，所以没有实际暴露。没有实现 issue；加调用方的 PR 按第 14 行实现。

### 读者 watch（#132 新增）

读者不注册，写下问题、命中条件和关键词，拿到一个私有 RSS 地址（N§2.1、N§2.6、N§7 "Follow a Topic"）。实现：#132。

**数据**：读者 watch 和管理员 watch 在同一张 `watches` 表，共用 `evaluateEventWatches`（`src/pipeline/watch/evaluate.ts`）现有的规则 1–3（1 板块范围；2 只看本 watch 没引用过、且在 watch 创建之后批准的文章；3 至少命中一个关键词）和 `watch_hits`。新增列都用 `ALTER TABLE ADD COLUMN`，不加 CHECK：

| 列 | 类型 | 含义 |
|---|---|---|
| `owner_kind` | text，非空，默认 `'admin'` | `admin` 或 `reader`；闭集在写入端校验 |
| `token_hash` | text，可空，唯一索引 | 读者 watch 令牌的 SHA-256（小写 hex）；管理员 watch 为 NULL |
| `creator_hash` | text，可空，索引 | 建立者网络地址的加盐哈希（第 3 节「公开写入口」第 4 条，用途 `reader_watch`） |
| `last_read_at` | integer，可空 | 私有 RSS 最近一次被读取的时刻 |
| `disabled_at` | integer，可空 | 停用时刻。停用 = `status = 'paused'` 且 `disabled_at` 非空，不可恢复 |

- 读者 watch 的 `slug` = `r-` 加 16 位随机小写 hex，与令牌无关，只用来满足 `slug` 非空唯一；任何公开路径都不用它。
- **公开的 watch 只有一个判定**：`adminWatchWhere`（`src/server/publication/watches.ts`，`watches.owner_kind = 'admin'`）。所有公开读取 `watches` 的查询都带它（watch 页、`/w/` 列表、首页、页眉、公开 watch RSS），公开查询里不给 `watches` 起别名。扫描测试固定 `src/server/publication/**` 和 `src/routes/**` 里每处 `watches` 读取都引用它。
- 读者 watch 的命中 `status = 'delivered'`：不进后台审核队列，也不满足公开读取的 `status = 'published'`。
- 后台的 watch 编辑只处理 `owner_kind = 'admin'`。读者 watch 在后台单独列出，只能停用，不能编辑或恢复；后台不显示 `token_hash` 和 `creator_hash`。

**令牌**：

- 建立时用 `crypto.getRandomValues` 取 32 字节（256 位），编码为不带填充的 base64url，43 个字符。
- 库里只存 `token_hash = sha256hex(token)`。明文只在建立的响应里返回一次，不写库、不进 `llm_calls`。应用代码不把令牌或完整的私有 RSS 地址写进日志。
- 日志：令牌在 URL 路径里，Cloudflare 的调用日志记录请求 URL，所以令牌可能出现在那里。这些日志只有账户所有者能读，而账户所有者本来就能在 D1 里读到所有 watch，所以没有人因此多得到访问权。
- 私有 RSS 地址：`{SITE_URL}/rss/p/{token}.xml`。令牌不匹配 `^[A-Za-z0-9_-]{43}$`，或按 `token_hash` 与 `owner_kind = 'reader'` 查不到：404。已停用：410。
- 不可枚举：令牌空间是 2^256；没有任何公开接口列出读者 watch；`slug` 与令牌无关，用 `slug` 访问 `/w/$slug` 被 `adminWatchWhere` 挡住（404）。
- 撤销：`revokeReaderWatch({ token })`（POST）把该行写成停用。撤销不退还建立额度。
- 私有 RSS 的响应头：`Cache-Control: private, no-store`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow`。私有 RSS 不出现在公开页面、公开 RSS 和页面的 loader 数据里。

**输入**：请求体大小只由第 3 节「公开写入口」第 1 条的全局上限在解析之前检查（`src/server/edge.ts` 的 `SERVER_FN_MAX_BODY_BYTES = 65536`，对所有 `/_serverFn/*` 的非安全方法请求生效），读者写入口没有单独的请求体上限。解析之后、规范化之前，先查每个字符串的原始长度：`question` 不超过 400 个字符，`criteria` 不超过 600，每个关键词不超过 80；超出时返回 413 `payload_too_large`，不写库。这些原始长度上限只对读者写入口生效，后台和其他 server function 不受影响。然后做 NFC 规范化、去掉首尾空白、把连续空白合成一个空格，再用 zod `.strict()` 校验。

| 字段 | 规则 |
|---|---|
| `question` | 10–200 个字符 |
| `criteria` | 10–300 个字符 |
| `keywords` | 1–5 个，每个 2–40 个字符，不区分大小写去重 |
| `industrySlug` | 可为 null（= 除 Finance 外的全部板块）；非 null 时必须是存在的板块，且不是 Finance |

- 三个文字字段共用字符白名单 `/^[\p{L}\p{M}\p{N} .,;:!?'()\-–—\/&%$#+@*]+$/u`。双引号、反引号、`< > { } [ ] = \ | ^ ~ _`、控制字符、零宽字符和双向控制字符都不在白名单里，校验时拒绝。换行和其他空白在规范化时合成一个空格，所以到达提示词的文字里没有换行。
- 白名单只约束格式。判定提示词 `buildWatchJudgeQuestion` 把问题和条件放在双引号里（`Topic Question: "…"`），这段文字不改。读者的文字里没有双引号和换行，但这不能阻止问题试图引导判定结果。钱和发布安全不依赖模型守规矩，只依赖确定性的防线：每日判定尝试上限、第 5 档预算准入、私有 RSS 只输出已批准文章且不含模型写的文字（见「命中」）。离线评估的题集要包含注入式的问题（见「开关」）。
- 关键词必填：规则 3 对没有关键词的 watch 不调用模型。关键词按 `matchKeyword` 匹配（纯 ASCII 单词按词边界，其他按子串）；`AI` 这类常见词会让一个 watch 匹配大多数事件，兜底是每日判定尝试上限和第 5 档预算准入。不从问题里自动抽关键词：用模型抽要在匿名入口上花钱；按词切分会让关键词过滤失去作用。
- 存什么、送到哪：问题、条件和关键词以明文存在 `watches`；问题和条件也以明文存在 `llm_calls.request_json`（判定请求），并发给模型提供方。watch 停用后这些文字仍然保留；删除已停用的读者行、清理 `llm_calls.request_json` 里的读者文字是以后单独的 issue（#132 的非目标）。`/follow` 页面用一行字写明这一点。

**上限**（常量 `READER_WATCH_LIMITS`，`src/server/reader-watch/limits.ts`，改值另开 PR）：

| 上限 | 值 | 超出时 |
|---|---|---|
| 每个网络地址每个 UTC 日的建立数（含已撤销、已停用的行） | 3 | 429 `per_network_limit` |
| 全站活跃读者 watch 数（`owner_kind = 'reader' AND status = 'active'`） | 200 | 503 `capacity_full` |
| 每个 UTC 日的读者 watch 判定尝试数（每次登记计一次，见「判定」） | 500 | 跳过当次事件余下的读者 watch，管理员 watch 照常评估；事件不标记，第二天继续（见「判定」） |

- 哈希里带 UTC 日期，所以每日建立数直接按 `creator_hash` 计数。这个哈希是假名化，不是匿名化：不同日期的哈希不同，但持有 `IP_HASH_SALT` 的人可以对一个已知地址重算出任一天的哈希。
- 建立是一条 `INSERT INTO watches … SELECT … WHERE (同一 creator_hash 的行数) < 3 AND (全站活跃读者 watch 数) < 200`。影响 0 行时再读两个计数，决定返回 429 还是 503。
- 建立不调用模型，不花钱。

**判定**：`evaluateEventWatches` 在现有规则之上只加下面几条；规则 1–3、去重、revision 标记都不变。

- `READER_WATCH_ENABLED` 不是 `"true"` 时，读者 watch 不参与评估（在 SQL 里排除），事件照常标记。关闭期间出现的进展，读者 watch 以后不补判。
- 读者 watch 不评估 Finance 板块的事件（N§4 "no personalized investment advice"；第六轮读者 Ask v1 不含 Finance）。
- 判定用同一个 `buildWatchJudgeQuestion`、同一个 `WATCH_PROMPT_VERSION`、同样的 logical key 写法。档位：读者 watch 是第 5 档（`CALL_TIERS.readerWatch`），管理员 watch 仍是第 4 档（`CALL_TIERS.watch`）。档位挂在模型客户端上，所以 `evaluateEventWatches` 给读者 watch 另建一个第 5 档的模型客户端。
- 每日判定尝试上限：计的是登记，不是 key，也不是真实发送。账本里没有 `completed` 行时，每次调用 `judge` 之前在调用当天（UTC）登记一次：第一次尝试、重试、前一天已经登记过的 key 再次调用，都各计一次。登记之后没有真正发送的调用也计一次：被预算拒掉、`CallInProgressError`（同一 key 正在另一个消费者里发送）、重试次数已用完。同一事件被重复投递、两个消费者同时判同一个 key 时，两边都登记。这些都只会让上限更早触发，不会多花钱。只有账本缓存命中不计：读者 watch 调用 `judge` 之前先查这个 logical key 在 `llm_calls` 里有没有 `completed` 行（`findCompleted`，`src/providers/ledger.ts`），有就直接调用（模型客户端返回已存结果，不发送，不登记）。没有就在 `reader_watch_admissions` 登记一次尝试：`INSERT INTO reader_watch_admissions (logical_key, day, created_at) SELECT ?1, ?2, ?3 WHERE (SELECT count(*) FROM reader_watch_admissions WHERE day = ?2) < ?4`。影响 1 行：放行。影响 0 行，或者读者 watch 的 `judge` 抛出 `CallFailedError` 以外的错误（例如第 5 档预算拒绝 `BudgetExceededError`）：推迟这个事件的读者 watch，即跳过这个读者 watch，这个事件余下的读者 watch 也直接跳过（不再登记），管理员 watch 照常评估，不抛错，事件的评估照常走完。读者 watch 的 `CallFailedError` 只跳过这一个 watch，不推迟。管理员 watch 的错误照旧抛出。评估结束时这个事件不标记（不写 `watch_evaluated_revision`），cron 的到期扫描以后重新入队；重跑时已经判过的 watch 走账本里的已存结果，不再付费。所以不需要规定管理员 watch 先评估。`day` = `utcDay(now)`。登记在预算准入之前，所以被预算拒掉的尝试也计一次。
- **已知行为**：推迟期间事件进入新的 revision 时，被推迟的读者 watch 下次只把最新 revision 的报道当作新报道，较早的报道放进「旧报道」。只在达到每日判定尝试上限或第 5 档被拒时发生，不多花钱。不加补判机制。
- 到期扫描（#92 `enqueueDueEvents`）按 `watch_scheduled_at` 从旧到新轮转，每轮最多 20 个事件，所以停在上限的事件不会挤掉其他事件；已经写入的命中不受影响。
- issue 原文"超出后新建请求返回明确的错误，不排队"针对建立请求：每地址上限和全站上限都立即返回错误码。每日判定上限不针对建立请求，它推迟的是后台判定，不是读者的请求。
- **命中**：读者 watch 的命中不调用 `write`，`summary` 写空字符串，`status` 写 `delivered`。私有 RSS 只显示该命中引用的（`rationale.articleIds`）、当前仍满足 `approvedArticleWhere` 的文章自己的标题和摘要，同第六轮日报条目的做法。条目标题是最新一篇仍可见的被引用文章自己的标题，标题为空时用固定文字 `Watch update`；不用事件标题（`events.title` 来自建立事件的那篇文章，可能没被引用或没被批准）。没有仍可见的被引用文章的命中不输出。读者行不是 `active`，或 `disabled_at` 非空，私有 RSS 返回 410。`rationale` 不是合法 JSON、没有 `articleIds`、`articleIds` 不是数组或是空数组时，私有 RSS 不输出这个命中。理由：第六轮"生成内容到达读者之前，仍然必须经过人工批准"，不放宽；送后台审核的话，审核量随匿名读者数增长；而且 write 平均每次 3,083 µ$，500 次命中最坏每天 $1.54，超过第 5 档的窗口。
- 不新增 write 或 reason 调用点，不需要新的 finishReason 探测。

**清理**：`sweepReaderWatches`（`src/pipeline/watch/reader.ts`）由 `runScheduled` 每轮 cron 调用一次，不看开关（它只停用、只删除）。

- 停用：`owner_kind = 'reader' AND status = 'active'`，并且满足下面任意一条，写 `status = 'paused', disabled_at = now, updated_at = now`：
  - `last_read_at IS NULL AND created_at <= now − 3 天`（建好后一直没有人订阅）；
  - `last_read_at <= now − 30 天`。
- 删除 `reader_watch_admissions` 里 `day` 早于 `utcDay(now − 7 天)` 的行。
- `last_read_at` 的写法：私有 RSS 每次读取执行 `UPDATE watches SET last_read_at = ?2 WHERE id = ?1 AND (last_read_at IS NULL OR last_read_at <= ?2 − 21600000)`，每个 watch 每 6 小时最多写一次。

**钱**（**推断**，基于 2026-10-26 的生产只读查询）：

- 生产还没有 watch 调用（**已验证**：`watches` 0 行，`llm_calls` 没有 `watch:` 开头的 key）。代理值：`judge` 槽位全部 `completed` 行，1,128 行，平均 133.8 µ$，最大 337 µ$，平均输入 3,174 token（Jev 输入 $0.042 / 1M token，输出免费）。watch 判定的输入有上限（新报道 ≤ 2,000 字符，旧报道 ≤ 2,000，摘要 ≤ 1,000，问题 ≤ 200，条件 ≤ 300），比 analyze 的判定小，所以 134 µ$ 偏高。
- 每天 500 次判定尝试：平均 500 × 134 = 67,000 µ$（$0.067）；按过去最大的一次样本估算，最坏 500 × 337 = 168,500 µ$（$0.169）。这两个数是估计，不是上限；硬上限是每日判定尝试上限和第 5 档预算准入。建立、撤销、RSS 读取都不花模型费用。
- 第 5 档只在 `reserved + spent + 估计 + floor(5) <= cap` 时放行。`floor(5)` = 第 1–4 档预留之和 = 500,000 + 400,000 + 200,000 + 100,000 = 1,200,000，`cap = 1,900,000`，所以读者判定只在当天 gateway 已用额度低于 700,000 µ$（$0.70）时能花钱，这个窗口与日报导语、discover 共用。按上面的估计，读者判定平均占窗口的 9.6%，最坏占 24%。
- 管理员 watch 在第 4 档，地板是 `floor(4)` = 1,100,000：`floor(5) − floor(4) = R4` = 100,000 µ$（$0.10）。当天已用额度在 $0.70 到 $0.80 之间时，读者判定被拒，管理员 watch 仍放行。这条按档位成立，跨事件也成立，所以不需要规定一个事件里管理员 watch 先评估。读者判定花不到第 1–4 档的保留额。
- 日报导语也在第 5 档，但日报在预算日开始（00:00 UTC）时生成（本节「gateway 五档」的「已知行为」），那时已用额度接近 0，导语和读者判定都能放行。改了 `digest.timezone` 后，日报在预算日中途生成，读者判定先用掉的第 5 档额度会让导语更容易被拒。
- 当天 gateway 已用额度超过 $0.70 时（**已验证**：gateway 当日花费 2026-10-24 $0.48、2026-10-25 $1.63、2026-10-26 $0.77，三天里一天在 $0.70 以内，两天超出），读者判定和其他第 5 档调用一样被拒（`budget_exceeded`），之后重新入队。

**开关** `READER_WATCH_ENABLED`：

- 不是 `"true"` 时：`/follow` 返回 404，公开页不显示 `/follow` 的入口；`createReaderWatch` 返回 403 `reader_watch_disabled`；判定不评估读者 watch。
- 不受开关影响：`revokeReaderWatch`、私有 RSS 读取、`sweepReaderWatches`。它们不花钱，只读或只停用。
- 打开开关另开一个只改那几行的 PR，并要使用者同意。打开之前：用 `wrangler secret put IP_HASH_SALT` 设好盐（至少 32 个随机字节）；做一次离线评估（N§6 "limit automatic delivery to low-risk personal briefings after evaluation"），题集包含注入式的问题。

## 7. 发布与审核

- 每个板块有 `publish_mode = auto | review`。Finance 固定为 `review`（N§4 guardrails）。自动批准在提交时用 SQL 重新判断文章当前的板块（`publish_mode = 'auto'` 且 slug 不是 `finance`），不只看分析开始时读到的配置（第 6 节「事件 revision」第 9、10 行）。上线时所有板块都设为 `review`。
- 审核记录绑定内容版本：`reviews(article_id, body_sha, decision)`。`auto` 模式由规则写一条自动批准记录。
- 公开读取层只读已批准的输入：事件页、Brief、时间线、RSS、日报和 watch 只用已批准的文章及基于它们生成的产物。Finance 的产物发布前同样要审核。已批准的输入、可见产物、可公开论断的定义见第 6 节。
- 模型输出、信源内容和读者输入一律当不可信数据处理：markdown 渲染前先净化，只允许 `http`/`https` 链接；所有写操作（后台，以及第 3 节「公开写入口」）校验 `Origin`。
- 读者写的文字（watch 的问题、条件、关键词）不出现在任何公开页面、公开 RSS 或页面的 loader 数据里，只出现在后台、模型请求（`llm_calls.request_json`）和该读者自己的私有 RSS 里。公开的 watch 只有管理员建的（第 6 节「读者 watch」的 `adminWatchWhere`）。
- Finance 每个页面显示"仅供参考，不构成投资建议"（N§4）。
- 发布后的更正写进 `corrections` 表，并在原页面公开显示（N§9 Trust）。

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
| `sources` | `(industry_id, feed_url)` 唯一；`kind rss\|html`、`fetch_rung`、`jina_enabled`、健康指标、`status active\|paused\|candidate`；`content_display full\|excerpt\|summary`（非空，默认 `excerpt`，用 `ALTER TABLE ADD COLUMN` 加，不加表级 CHECK，因为加 CHECK 会生成重建表的迁移；取值闭集在写入和读取两端各校验一次，读出未知值按 `excerpt`） |
| `articles` | `canonical_url` 唯一；`stage`、原文发布时间、抓取时间、`fetch_rung`、`body_sha` |
| `analyses` | `article_id` + `prompt_version` 唯一；五维分数、内容类型、证据标签、总分 |
| `reviews` | `(article_id, body_sha)` 唯一；`body_sha` 不能为空，没有正文时用摘要文本的 hash；`analysis_id`（可空，批准的是哪一行分析，第 6 节「读者看到的分析行」） |
| `dlq_messages` | 死信消息原文、来源队列、失败次数、重放状态 |
| `events` / `event_articles` | `event_articles.article_id` 唯一；`events.revision`；`events.withdrawn_through`（非空，默认 0，第 6 节「事件 revision」）；`events.artifacts_pending_since`、`events.evidence_pending_since`（可空，上次入队之后第一次加 1 的时刻，第 6 节「去抖」） |
| `event_artifacts` | 见第 6 节的键 |
| `claims` / `claim_evidence` | 证据 = `(article_id, body_sha, quote, start, end, stance)` |
| `digests` | `(industry_id, kind, period_start)` 唯一 |
| `watches` / `watch_hits` | `watch_hits (watch_id, event_id, event_revision)` 唯一；`watches.owner_kind admin\|reader`（非空，默认 `admin`，ADD COLUMN，不加 CHECK）；`watches.token_hash` 唯一（可空，只有读者 watch 有）；`watch_hits.status` 增加 `delivered`（读者 watch 的命中，不进审核队列、不公开）。见第 6 节「读者 watch」 |
| `reader_watch_admissions` | `id` 自增主键，`logical_key` 非空，不唯一；按 `day` 建索引；每行是一次读者 watch 判定尝试，用于每日尝试次数上限（第 6 节「读者 watch」） |
| `questions` | Ask：后台提问（`origin = 'admin'`），以及开关 `ASK_PUBLIC_ENABLED` 打开时事件页的读者提问（`origin = 'public'`，只回给持有令牌的提问者，不公开发布）。`origin` 无表级 CHECK（加 CHECK 要重建表），写入方只写这两个值 |
| `source_candidates` / `discovery_runs` | 发现 |
| `companies` / `filings` / `financial_facts` | EDGAR |
| `funding_rounds` | `(company_key, round_key)` 唯一，`superseded_by` 记录更正 |
| `corrections` | 公开更正 |
| `llm_calls` / `budgets` / `settings` | 见第 6 节 |

**已知限制**：`canonical_url` 在所有板块之间唯一，一篇文章只属于最先采到它的信源所在的板块，只按那个板块的配置分析。同一篇文章同时出现在两个板块的信源里时，第二个板块看不到它。以后如果需要，再把分析结果改成按 `(article_id, industry_id)` 存。

### 迁移

从 `COLLECT_ENABLED` 第一次打开起，`articles` 和所有被外键引用的表不再用"重建表"的迁移；加列用 `ALTER TABLE ADD COLUMN`；需要改 CHECK 的，另开 issue 先设计。

## 10. 测试、CI 与合并

- Vitest + `@cloudflare/vitest-plugin`（原 `@cloudflare/vitest-pool-workers` 已改名并弃用，**已验证**，npm）；模型、Jina、外部网站都用本地假服务。CI 里没有 Cloudflare 凭证也必须能跑测试。
- 本地测试和 `test:ssr` 用 `wrangler.jsonc` 里的 `env.test`（#2）。它只声明 DB、BODIES、四条队列和 vars，不包含 AI、Vectorize 和 send_email，因为这三个绑定在本地也会开一个远程代理会话，要凭证（**已验证**，#2：不用 `env.test` 时 vitest 报 "Failed to start the remote proxy session"）。它的 `routes` 和 `crons` 清空，以免测试用的 Worker 绑到生产域名上。新增的绑定如果本地测试要用，同时加进 `env.test`；用不到的，测试里用假对象。
- 非法的 search param 由 TanStack Router 用 307 重定向到规范 URL，比如 `/?audience=bogus` 跳到 `/`（**已验证**，生产环境，2026-10-23）。冒烟测试里的 `fetch` 默认跟随重定向，只看最终状态码；要断言"不跳转"，就加 `redirect: "manual"`。
- CI 跑在使用者 wsl 主机上的 self-hosted runner：`runs-on: [self-hosted, wsl]`，runner 是 `wsl-ainews-1` 和 `wsl-ainews-2`，用主机上的 `~/runners/setup.sh ainews:2` 注册，以 systemd 用户服务运行。原因：GitHub 托管的 runner 被账号账单拦住了（2026-10-22）。这台主机同时跑着其他仓库的 runner，`_work` 在两次运行之间不清空，所以测试和脚本不能写死端口（向系统要空闲端口），不能依赖工作目录以外的状态；每个 job 都要设 `timeout-minutes`。
- CI（GitHub Actions，`ci.yml`）：`typecheck`、`lint`、`test`、`build`、`test:ssr`。main 的 ruleset 要求 CI 通过；只允许 squash 合并；开启 auto-merge；合并后删除分支。
- 同一个 `ci.yml` 里的 `deploy` job：只在 main 上、CI 通过后执行迁移和 `wrangler deploy`。
- 一个 issue 一个分支、一个 PR。PR 正文写 `Closes #n`。
