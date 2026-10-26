# Scope 决定（2026-10-22）

来源：设计稿 v0.2（`core-design.html`）页底导出，由使用者粘回对话，原样保存。
同时附加的要求：本周内完成 Newsren 计划书的 Stage 1–4。

与下面 scope 行冲突时的解读规则（待使用者确认，见 `docs/plan/week-plan.html` 01 节）：
Q 答案和"Stage 1–4 全做"优先于 scope 行。

```
ainews scope 决定（* = 改了推荐）

## v1
- 采集 RSS / Atom
- 采集网页列表页
- JS 渲染页面
- 正文抓取梯
- 去重
- 预筛
- 评分与门槛
- 摘要与标题改写
- 事件归组
- 日报
- 公开网站
- RSS 输出
- 人工覆盖
- 模型调用账本
- 多行业
- AI 起草行业配置
- AI 发现信源
- 信源健康监测
- 日报邮件 *
- 四个种子板块
- 条目级溯源
- 证据类型标签
- Story Brief
- 三档解释
- 发布前审核
- 金融安全边界
- 事件时间线
- 追到一手来源 *
- Follow a Topic *
- 论断级证据 *
- 课堂材料 *
- 行业影响报告 *
- API 型信源 *
- 可信度与成本看板 *

## 以后
- 周报 / 月报
- 候选自动启用
- 定期重新发现
- 门槛校准
- 站内搜索
- Ask Newsren

## 不做
- 模型排行榜
- X / 微信公众号信源
- 讨论帖热度信号
- 飞书推送
- IndexNow 提交
- 精选账本 + 增量同步 API
- 公开 JSON API *
- MCP / Agent Markdown *
- 模块插件系统
- 访客反馈
- 全文翻译
- 图片代理 / OG 图
- 多管理员 / 角色

## 问题
- Q1 · 网站给谁看？ 公开阅读，只有后台需要登录
- Q2 · 后台怎么登录？ 有自己的域名接入 Cloudflare：Access 只保护 /admin *
- Q3 · 输出语言？ 统一英文 *
- Q4 · AI 发现的信源怎么启用？ 评估过线的自动启用，我事后可以停用 *
- Q5 · 事件归组用什么召回候选事件？ v1 就上 Vectorize + 嵌入 *
- Q6 · 模型怎么付费？ AI Gateway Unified Billing：预付 credits，一个账单
- Q7 · 报告节奏？ 日报 + 周报 *
- Q8 · 预期规模？ ≤ 5 个板块，每个 ≤ 50 个信源
- Q9 · 站名？ Personal News
- Q10 · 先跑通哪个板块，以及你已知的必盯信源？ Technology, arXiv, cs.ai, MIT Technology Review
- Q11 · Ask Newsren 做成什么形式？ v1 只在后台给管理员用 *
- Q12 · Follow a Topic 做成什么形式？ 管理员建关注主题，每个主题有公开页和 RSS
- Q13 · 抓取梯要不要接第三方免费 reader（第 3 档）？ 接 Jina Reader，全局开关默认关，可以按信源单独打开
- Q14 · 抓到的正文存在哪里？ 存在 R2，长期保留 *
```

# 技术与执行决定（2026-10-22，第二轮）

使用者原文：

```
1. cloudflare account 使用 simon 这个账户
2. 技术栈采用 TanStack, using follow instruction
   Build a TanStack Start application with file-based TanStack Router routes, validated search params, route loaders, typed server functions, full-document SSR, and streaming. Keep server-only work behind explicit boundaries, choose the appropriate SSR mode per route, and target the deployment runtime without changing the application model.
3. 部署在 cloudflare 单 worker 上，使用 D1 + Drizzle + R2, domain name news.ioenv.com , 管理员邮箱 simon.jinyu.liu@gmail.com , 我会自行在后台配置 zero trust app, AI Gateway 我自行充值
4. 固定流程使用确定性脚本和逻辑，快速判断使用 Jev 作为判断模型，其它考虑使用 google gemini 3.8 flash, Claude sonnet 5.5 或者 OpenAI 等效模型
5. 所有规划好的工作在 githonllc/ainews 上开 epic issue + sub-issues, PR + CI + auto merge
6. JINA_API_KEY, CF_AI_API_TOKEN, CLOUDFLARE_ACCOUNT_ID 储存在 .env.prod 中
7. AIHOT 作为参考项目，@docs/Newsren_Plan.md 是实际项目需求必须满足，读者邮件订阅以后再做. 内容抓取暂时不考虑需要 Browser 才能抓取的内容，优先选择 jina 和CF的免费额度可以支持的内容源
8. 项目进度无需过多顾虑timeline，按照全部完成的优先级做任务拆解和排期，可以参考选项A的安排，但是无需砍掉最耗时的核心功能（可以延后）
CF worker name ainews-app
```

由此对第一轮的调整：

- 截止日期取消，按里程碑 M0–M4 排期（`docs/plan/week-plan.html`）。
- "JS 渲染页面"和抓取梯第 4 档（Browser Run）改为以后；需要浏览器才能抓的信源不收。
- 第一轮 01 节的四处解读照此执行：Ask 只在后台；周报进 v1、月报以后；过线自动启用，带上限；日报邮件只发管理员，读者邮件订阅以后。
- 技术栈以 `docs/architecture.md` 为准，替代周计划 v1 的 04 节和评审文件里 Hono 相关的条目。

# 第三轮决定（2026-10-22）

- **Newsren 的两个缺口按推荐做**（使用者原话："两个缺口都按推荐做"）：
  - N§2.1 My Newsren：读者偏好存在读者自己的浏览器里（`localStorage`），不发给服务器。包括解释档位、关注的板块、收藏的 watch。规格见 #10 和 #17。
  - N§9 Usefulness：每个 Story Brief 和每份日报下面放"有用 / 没用"两个按钮，匿名、不收文字。这是公开站唯一的写入口，原始 IP 不入库，同一个人对同一项每天只算一票。规格见 #24。
- **AI Gateway** 的 id 是 `ainews`，使用者已经建好。
- **部署凭证**：新建了 Account API token `ainews-deploy`，原来的个人 token 不再给本项目用。`.env.prod` 和 GitHub secret `CLOUDFLARE_API_TOKEN` 都换成了它。
- **CI 改在使用者的 wsl 主机上跑 self-hosted runner**（`wsl-ainews-1`、`wsl-ainews-2`），原因是 GitHub 托管的 runner 被账单拦住了。
- **Zero Trust 应用和 Web Analytics 由使用者配置**。AUD tag、team domain 和 `CF_BEACON_TOKEN` 拿到后再写进 vars。
- **分工**：ainews-design 会话负责设计和评审；ainews-impl 会话负责实现和事务性操作（push、开 PR、合并、部署、改仓库设置）。

# 第四轮决定（2026-10-23）

- **每日模型预算 $2**，按渠道拆：`gateway` $1.90（Jev、Gemini、Sonnet），`workers_ai` $0.10（嵌入），`jina` $0。#3 的种子数据已写入生产库，以后在后台（#9）改。
- **Jev 从 AI Gateway credits 扣费**（使用者在 Gateway 日志里确认）。嵌入模型 bge-m3 的计费渠道还没确认，记在 #9 的待办里。
- **Zero Trust 应用由 ainews-impl 用 API 建**：`ainews-admin`，只保护 `news.ioenv.com/admin`，只允许 `simon.jinyu.liu@gmail.com`，会话 24 小时。使用者登录后，后台页面和 Check session 都显示了邮箱，M0 完成。
- **已知限制**：架构测试 R1/R2 只查直接导入，不查传递导入（经过 `components/` 或后台 helper 间接导入 `server/db`、`providers/`）。后续单独开 issue 补。

# 第五轮决定（2026-10-23）

- 2026-10-23 使用者决定：不用 Sonnet；`reason` 用 Gemini 3.8 Flash（备选 OpenAI gpt-6-luna）。见 #53。
- 2026-10-23 ainews-design 决定：Q_INGEST 消费并发上限为 2，防止补队积压时突发调用触发网关限流（05:42Z 出现 32 次 2018）。见 #53。

# 第六轮决定（2026-10-26）

使用者原话（2026-10-26）："以需求文档 @docs/Newsren_Plan.md 为准，你来替我做最佳产品和用户体验的决策，我全部采纳你的建议"；
随后补充："特别注意，你的决策着眼点是产品和用户体验，而不是最容易实现的方案或者成本最低的方案或者风险最小的方案"。
本轮各条是 **ainews-design 代决**，依据是上面两句授权和 `Newsren_Plan.md`（N）。起因是 2026-10-26 的全面审查：
15 个 PR 零评审合并，合并的 M2–M4 功能读者在线上几乎看不到。经过两路评审，都是 Anthropic 家族，标 [degraded]。

## 审核与发布（N§6 "Require human approval for publishing initially"，N§4 "Human editorial review for any finance story"）

- 生成内容到达读者之前，仍然必须经过人工批准。不放宽这条，改的是批准的成本：
  - **事件级一键批准**：一次动作发布该事件当前 revision 的全部产物，以及带 verified 原文片段的论断。Finance 仍逐条批准。
  - **已发布版本只在"已批准文章集合单纯变大"时保留**：新 revision 生成待审的新版本，旧版本继续显示，直到新版本被批准。
    拒绝文章、人工改写、改板块、重新分析，都要在同一个 `batch()` 里立刻撤下旧版本。
  - **去抖**：只对 revision 已变化、且 `updated_at` 距今 ≥30 分钟的事件重生成，一次审核会话只触发一次。
  - **论断守卫**：没有 verified 原文片段的论断，不能批准，也不能公开。
- **日报和周报**：条目自动发布，但只用已批准文章自己的标题和摘要。模型写的 `one_liner` 和导语另走审核，批准后才显示。
  Finance 的日报和周报整份人工发布。管理员邮件要等 Email Service 接好，所以重开 #12，标明这一项还没完成。
- **"已批准"的定义只有一个**：pipeline 里约 20 处内联复制，全部换成 `approvedArticleWhere`。

## 读者功能

- **产物全覆盖**（N§7 "one-click student, educator, and professional explanations"）：每个入选事件都生成 Story Brief、
  三档解释、学习材料和本板块的编辑产品，不设分数门槛。调度器和 build 共用同一个资格函数。
- **生成物都带来源**（N§6 Critical product requirements 第一条）：Story Brief、三档解释和学习材料，都要显示来源文章、发布时间和抓取时间。
- **Ask 开放给读者**（N§7 Stage 2 "Readers get useful, evidence-backed answers"，N§1 Reader loop）：本条取代第二轮"Ask 只在后台"。
  - 入口：每个事件页都有 "Ask about this story"。回答只依据该事件已批准的正文，逐句引用；查不到时说明查不到的是什么。
  - 回答只给提问者本人，不发布到公开页。限流按网络地址设，只防滥用。
  - **单独预算、服务端开关**（使用者原话，2026-10-26："读者ask走单独的budget，且受服务端的feature flag控制启用与否"）：
    - 读者 Ask 的调用记到独立的预算渠道 `ask`，不占 `gateway` 的 $1.90；`ask` 用完后，当天的 Ask 显示"今天的提问额度已用完"，不影响流水线。
    - 新开关 `ASK_PUBLIC_ENABLED`，和其他安全阀一样只认字符串 `"true"`，默认 `"false"`。为 `"false"` 时，公开页不显示入口，服务端也拒绝请求。
    - `ask` 的日额度和开关的打开时间都由使用者在打开时决定，开关单独开 PR。后台的 Ask 仍走原有渠道，不受这个开关影响。
  - 开放的前提是先做离线评估（N§6 "after evaluation"）：题集上引用正确率与拒答正确率都达标。
  - v1 不含 Finance 板块（N§4 "no personalized investment advice"）。
  - 契约 `docs/architecture.md` 的 `questions` 行另开一个 PR 修改。
- **读者自建关注**（N§2.1 最高优先级、N§2.6、N§7 "Follow a Topic: save specific questions"）：读者不注册，
  用自然语言写下要跟的问题和命中条件，系统给一个私有 RSS 地址。只在出现实质进展时命中，同一进展不重复命中。
  管理员建的 watch 保留，作为公开示范，并在公开站加一个列表入口。邮件推送等读者订阅以后再做。
- **补齐 N§3 Technology 的编辑产品**：Launch Reality Check、Technology Evolution Timeline。Technology 是目前唯一有数据的板块。

## 文章阅读页（使用者原话，2026-10-26："我希望在保留原始链接的同时，能够在服务端保存抓取到的内容，用于格式化后默认展示"）

- 新增公开页 `/a/$articleId`。首页、板块页、事件页里的文章标题默认链到这个页面；每张卡片和阅读页上都保留"在 {信源} 阅读原文"的原始链接。
- 页面从上到下：标题；信源、发布时间、抓取时间；原始链接；带"AI summary"标签的 AI 摘要；格式化后的正文；页底再放一次原始链接。
  Finance 文章页显示免责声明（N§4）。
- 正文只显示已批准的那一版（`reviews.body_sha`），经过 `approvedArticleWhere`。R2 里没有正文时，退回到摘要加原始链接。
- 渲染：在服务端把 markdown 转成 HTML，并按白名单净化。链接只允许 http/https（`safeHttpUrl`），外链加 `rel="noopener nofollow"`。
  图片只允许 https，加 `loading="lazy"` 和 `referrerpolicy="no-referrer"`。去掉 script、iframe、form、style。
  排版：正文宽度约 68 字符；标题、引用、代码、表格的样式要齐全，表格可横向滚动；亮色和暗色都要做；375px 下不能出现横向滚动。
- `<link rel="canonical">` 指向原文。
- 证据联动：Inspect evidence 里的每条引文都链到 `/a/$id#:~:text=…`，读者能在站内看到高亮的原文段落；原始链接同时保留。
- **版权（N§6 Editorial quality gate 的 "licensing"）**：每个信源新增一个显示方式，取值 `full`、`excerpt` 或 `summary`。
  - `full`：显示全文。
  - `excerpt`：显示开头若干段，不超过正文的 25%，也不超过约 300 词，之后接"在 {信源} 继续阅读"。
  - `summary`：只显示摘要。

  新加的列默认是 `excerpt`。每个信源的取值：
  - 政府和公共领域来源（Federal Reserve、SEC、FINRA、NIST、ed.gov、NCES、CISA）用 `full`。
  - arXiv 用 `full`：现在存的是摘要，arXiv 的元数据（含摘要）采用 CC0。
  - 商业媒体（MIT Technology Review 等）用 `excerpt`。

  管理员可以在后台把任何一个信源切到 `full`，前提是已经确认对方允许转载。

- RSS：条目链接改成 `/a/$id`，描述里带上原始链接；guid 不变。
- 这个页面不调用模型，不占每日预算，排在 W2 的第一项。

## Funding Round Tracker（#23，N§3 line 104、N§4）

- 模型提取只生成提案。管理员批准是写入 `funding_rounds` 的唯一途径，提案本身不可修改，新报道生成新提案。
- 管理员的操作有四种：批准为新轮；批准为对已发布轮 X 的更正；拒绝；撤回某个已发布轮。
  - 提案的批准和拒绝都带 `WHERE state='pending'`，并用 `changes()=1` 串起来。
  - 更正行 = X 的全部字段，再用提案里原文明确写出的字段覆盖。
  - `superseded_by` 只能从 NULL 写一次。写入顺序要实测外键行为后再定。
  - 批准前检查：所有来源文章都已经批准。
- 管理员体验：每条提案预先配好最可能对应的已发布轮，逐字段列出差异和支持每个字段的原文片段。
- 读者体验：`/funding` 可以按板块、阶段、投资方筛选，并显示趋势。每个数字都链接到原文片段，被更正的记录显示更正时间和原因。不给创业公司排名。
- 字段政策：只记录原文明确写出的字段。身份由公司、具体轮次、公告日期三项确定，缺失或冲突时由管理员在提案上决定。

## 信源（N§7 Stage 1 "Approved source feeds"）

- 每个板块都要同时有一手来源和独立报道，这样才能把厂商的说法和独立评测对照起来。候选：
  - Technology 增加：厂商一手新闻页（OpenAI、Google DeepMind、Anthropic）、独立评测（Epoch AI）、CISA 安全通告。
  - Education：The Hechinger Report、EdSurge、ed.gov 新闻、NCES。
  - Industry：Supply Chain Dive、Manufacturing Dive、NIST 新闻。
  - Finance：Federal Reserve press releases、SEC press releases、FINRA news、TechCrunch Venture。
- 每个候选都用项目 UA 验证：robots、feed、正文抓取梯，不需要浏览器才算通过。ainews-design 从验证通过的里定名单。
  写生产时，先 dry-run，执行一次，前后的计数都要贴出来。

## 钱与开关

- **每日预算仍是 $2**（使用者原话，2026-10-26："预算按 $2 执行"）：`gateway` $1.90，`workers_ai` $0.10，`jina` $0。
  上面的读者功能都在这个上限内做。设计方因此补一条：**按读者价值分配预算**，额度不够时先保证排在前面的：
  1. 文章预筛、评分与摘要（Stage 1）；
  2. 已批准事件的 Story Brief 与三档解释；
  3. 论断与证据；
  4. 学习材料、板块编辑产品、watch 判定；
  5. 日报和周报的导语。

  读者 Ask 不在这个排序里，它走单独的 `ask` 预算（见上）。额度用完后，后面的任务排队到第二天，不丢数据。后台预算页要显示每一档当天的花费。

- 所有新的 write 和 reason 调用，做一次批量真实探测，确认 `finishReason=STOP`，预计花费不超过 $0.10。
- `DISCOVERY_ENABLED` 保持 `"false"`。重新打开之前要先满足：probe 遵守 crawl-delay、带项目 UA、跨主机查 robots；
  有当天预算；websearch 经过 `createModelClient` 记账。改这个开关仍然要单独开 PR，并经使用者同意。

## 流程

- 每个 PR 合并前，在 GitHub 上留两路评审的评论，适用时标 [degraded]。合并用 `--match-head-commit`，绑定评审过的 head。
- #23 和 #24 的 0020 迁移号冲突：后合并的一方 rebase 后，重新运行 `db:generate`。
- 5 个 `/private/tmp/ainews-review-*` worktree 的内容 main 上都已经有了，用 `git worktree remove` 清理。

## 仍需使用者亲手做

- 打开读者 Ask 时，定 `ask` 预算的日额度，并同意 `ASK_PUBLIC_ENABLED` 的开关 PR。
- 在 `ioenv.com` 上接好 Email Service，并确认发件地址。
- 提供能读 AI Gateway 日志的凭据，用于 M1 关口的对账，并确认 embed 的计费渠道。

# 第七轮决定（2026-10-26）

W1（#80–#86、#92、#95）在本轮做完并部署。除标明"使用者原话"的条目外，其余都是 **ainews-design 代决**，授权与第六轮相同。
每条后面括号里的编号，是实现它的 issue 和 PR。

## 站点与语言

- **站名改为 Daily**（使用者原话："整个网站名称由 Personal News 改为 Daily"）。读者看到的站名只在 `src/lib/site.ts` 的
  `SITE_NAME` 定义一次，抓取 UA 是 `DailyBot/1.0 (+https://news.ioenv.com)`。（#89，PR #91）
  - 模型提示词里还有 17 处 "Personal News"（`src/pipeline/artifacts/prompts.ts` 14 处，`digest/prompt.ts` 2 处，`evidence/prompts.ts` 1 处），
    读者看不到，**这次不改**：改提示词文字会改变 prompt hash，已有产物都要付费重新生成。下次因为别的原因改这几份提示词时，顺手一起换掉。
  - 一起改名的还有 `SEC_USER_AGENT`、README、AGENTS.md 和 architecture.md。不改的：仓库名、Worker 名、域名、
    浏览器存储键 `pn:prefs:v1`（改了读者的设置会丢），以及需求原文 `Newsren_Plan.md`。
- **读者看得到的文字一律用英文**（使用者原话："在进行UI改进的时候，记住整个网站全部使用英文"）。
  范围包括邮件、RSS、空状态和免责声明，也不加载中文字体。CI 会扫描 `src/components`、`src/routes`、`src/lib`、`src/server/publication`，
  注释以外的字符串和页面文字里不能出现中文。后台页面不在扫描范围内。（#95，PR #96）
- **UI 采用墨水屏风格**（使用者原话见 #87；补充："墨水屏方案看起来好多了，可以采纳，同时可以再借鉴一下 fastcade 项目的
  landing page 的页面风格设计。不过字体方面选择适合阅读的字体"）。mock v2：<https://claude.ai/artifact/Lfc3QdrDPknc2twUejatuL>。
  - 主色是灰和白。取消各板块的强调色，只保留一种低饱和度的语义色。与 TASTES 里偏好饱和色的那一条冲突时，以使用者原话为准。
  - 版式借鉴 fastcade landing page：5:4 不对称首屏、一屏一个大元素、3px 实线、整幅灰色色带、直角。
    不借鉴它的配色、倾斜排版和无衬线大标题。首页当日卡片只放真实数据。
  - 字体：标题用 Newsreader，正文用 Literata（自托管），界面控件用系统无衬线体。
  - 新增的硬编码颜色类不能比基线多。这项放在最后一波（W5）。favicon 要换成同样风格，控制台不能再报 `/favicon.ico` 404。（#87）

## 信源名称（#80，PR #93）

- 没有真实信源的文章（例如一手文件），在各自板块下挂到占位信源 `feed_url='system:primary-documents'`。
  占位信源的状态是 `paused`，没有 `site_domain`，所以采集永远不会认领它；第一次用到时才创建。
  不采用"匹配不到信源就跳过"，因为那样会丢掉大部分一手来源（N§2.5）。
  公开页的来源栏显示文档所在的域名；公开的信源列表不列出占位信源。
- 后台新建、编辑信源，以及批准候选信源时，`feed_url` 都不能以 `system:` 开头：先去掉首尾空格再判断，大小写不敏感，违反返回 400。
  SQL 里也带同一个条件，作为第二道防线。

## "已批准"的定义（#84，PR #101）

- 只有一个定义：`APPROVED_ARTICLE_SQL` / `approvedArticleWhere`。下面三个常量是例外，每个都只能在白名单里出现一次：
  - `ANY_BODY_APPROVED_SQL`：不要求正文版本一致，只用于证据的孤儿恢复，全仓只允许 `src/pipeline/evidence/primary.ts` 用一次。
    要不要收紧，在 #103 决定。
  - `APPROVED_BY_SQL`：阅读页要返回批准人，不能复用 EXISTS 的写法。
  - `CARD_COLUMNS` 里的副本：别名是 `a2`/`r2`。
- 测试 `EXPECTED_USES` 固定每个 pipeline 文件引用这个定义的次数，任何一处被删掉，测试就变红。
  九个文件还缺行为测试，后台 TypeScript 里还有一份副本，都记在 #102。

## 文章阅读页（#86，PR #97）

- 摘要标签分三种："AI summary"、"Editor's summary"、"Summary from {source}"。
  全文模式的署名是 "Original text by the authors, as published by {source}."；证据引文上的链接文字是 "Highlight in original ↗"。
- `excerpt` 模式不显示图片。字数只统计含字母或数字的词，图片 alt 也算在内。
- HTML 净化：只有 `svg` 和 `math` 的 `/>` 算自闭合；结束标签的名字后面必须紧跟空格、`/` 或 `>`；
  空元素只删掉标签本身；扫描是线性的，200 KB 的恶意正文要在 500 ms 内渲染完。
- R2 读取失败时，页面显示摘要和原始链接，返回 200。
- 摘录里如果出现证据引文，要另外标出来，放在 W2 做。（#100）
- 证据引文落在显示范围之外时，链到原文的 `#:~:text=` 并注明，不在站内显示超出版权范围的正文。
- arXiv 用 `full` 时，页面同时保留 AI summary 和作者原文，原文前加 "Abstract" 小标题。
  切到 `full` 需要写生产库，SQL 和 dry-run 已经准备好，**等使用者同意**。
- watch 页里的文章链接改到 `/a/$id`，放在 W3。

## 重新分析（#81，PR #108）

- 重新分析不删账本，改为文章的 `analysis_generation` 加 1。这个值进入所有分析调用的账本 key，旧答案不会被拿回来，
  旧的 `llm_calls` 和 `analyses` 行都保留。generation 为 0 时，key 和以前逐字节相同，部署后存量文章不会被重新付费分析。
- 改 stage 时，必须同时满足"期望的旧 stage"和"期望的 generation"两个条件；分析结果提交时，也检查 generation，被新一轮重新分析超过的结果不写入。
- 请求参数用 zod 校验，缺少 `expectedStage` 返回 400。
- **已知行为，接受**：管理员在上一轮还没跑完时再点一次，进行中的那次调用照样计费。#81 已经否决了加租约的方案。
- 重新分析进行期间，公开站继续显示旧的已批准版本。
- 后续问题记在 #109：事件 revision 加 1 的时机；EDGAR 文档抓取失败时会写入占位正文；公开页、后台、产物三处读取的"最新分析行"规则不一致。

## EDGAR 修订（#83，PR #106）

- `financial_facts.superseded_by` 的含义是："比它新、已经批准的修订文件中，最新的那条事实"。匹配条件是同公司、同概念、同单位、同 `period_end`，
  并且来自不同的 filing。每次批准或拒绝，都在同一个 `batch()` 里用一条语句，从当前审核状态整体重算。
  结果只取决于当前状态，与批准的顺序无关。唯一的读取方只判断这个字段是否为 NULL。
- 重新抓取时如果正文变了，文章回到审核队列；在新版本被批准之前，原文件的数字保持隐藏（N§6）。
- 第六轮"`superseded_by` 只写一次"那条只针对 `funding_rounds`；filings 的修订指针在拒绝或撤回时要回退。
- 已知缺口：修订被批准后，原事件的 revision 不加 1，事件产物不会因为修订而重新生成。放到 W4 的 EDGAR 跟进里做。

## 事件归组（#82，PR #88）

- 新建事件的分支也用 `changes()=1` 串起来。消息重投时返回 `already_grouped`，不再给事件的 revision 加 1。
- "重新分析的结果落库之前，就按新 revision 生成了产物"这个风险，由 W2 的去抖处理，并记在 #109。

## Watch 命中（#85，PR #105）

- 所有板块的命中都先进入待审，`auto` 板块也一样（设计裁决 1）：命中摘要是模型写的。
- 公开站页眉只有在存在 watch 时才显示 Watches 入口。
- 写入命中时不检查 revision：命中的含义是"在 revision R 出现了进展"。文章之后被撤下，由公开页的"已批准"条件把它挡住。
- 去重：每个 watch 先去掉自己已经引用过的文章，没有剩下的文章就不调用模型。新建的 watch 只看创建之后才批准的文章（`created_at`，不是 `updated_at`）。
  账本 key 包含这次真正送审的文章集合的 hash。
- 接受：和上一次评估的分界恰好是同一毫秒批准的文章，会被漏掉。

## 调度（#92，PR #107）

- 产物、证据、watch 三类调度都用 `enqueueDueEvents` 选事件：只选当前 revision 还没有终态结果的事件。
  排序是 `<kind>_scheduled_at ASC, id ASC`，入队时间在发送成功之后才写，所以总是失败的事件不会一直占着队头。
- 终态包括：成功、解析失败、`CallFailedError`。可以重试的错误不写完成标记，R2 读取出错也算可以重试。
- 迁移回填只标记旧查询已经不会再入队的事件。新的待处理集合是旧候选集的子集。
  每次运行的花费可以比以前多，因为轮转会轮到旧 `LIMIT 20` 之外的事件，但上限是"待处理事件数 × 产物类型数"。
- 去掉产物的分数门槛（第六轮）会增加调用，单独放在 #104：等预算分档上线后再做，PR 里要写出每天预计增加的花费。

## 后续波次的调整

- **信源**（使用者原话："最后，完成全部任务之后，我需要你补充一下新闻数据源，可以参考 https://aihot.news/"）：
  第六轮"每个板块都配一手来源和独立报道"并入 W6（#90），排在 W5 之后。aihot.news 只作参考，不用它的名称和 logo。
  每个信源都要通过接入红线，按 #8 的方式开 draft PR，附确认清单。
- **Funding Round Tracker（#23）在 W4 按第六轮的 D1 设计重做。** 之前的 v3 保存在分支 `wip/issue-23-v3`，PR #74 已关闭。
  契约 #76 的第二版作废并关闭，W4 写第三版时从 main 重新起草。

## 评审流程

- 合并前，要有绑定评审过的 head 的凭据，合并用 `--match-head-commit`。rebase 以后，按 range-diff 和冲突的解决方式重新出凭据。
- 第一路来自非 Anthropic 家族，顺序是 codex → agy → grok。三家都没有额度时，第一路换成 fable，第二路是 opus 的契约评审，凭据标 [degraded]
  （#108 就是这样，探测时间 17:39Z）。
- 修复只要不超出上一轮的修复清单，增量由 ainews-design 亲自评审，不再派新一轮评审。
- RED commit 可以因为缺少新接口而 typecheck 失败，前提是在 PR 正文里写明。证明缺陷本身的测试（defect witness）要长期保留，后面只改调用方式。
- PR 正文的变异表要区分"实现者亲自跑过"和"agent 报告"两种。

## 仍需使用者亲手做（本轮新增）

- 同意把 arXiv cs.AI 的 `content_display` 改成 `full`。这是一行生产写入，不花钱，可以撤回。
