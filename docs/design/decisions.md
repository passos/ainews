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
  - 开放的前提是先做离线评估（N§6 "after evaluation"）：题集上引用正确率与拒答正确率都达标。
  - v1 不含 Finance 板块（N§4 "no personalized investment advice"）。
  - 契约 `docs/architecture.md` 的 `questions` 行另开一个 PR 修改。
- **读者自建关注**（N§2.1 最高优先级、N§2.6、N§7 "Follow a Topic: save specific questions"）：读者不注册，
  用自然语言写下要跟的问题和命中条件，系统给一个私有 RSS 地址。只在出现实质进展时命中，同一进展不重复命中。
  管理员建的 watch 保留，作为公开示范，并在公开站加一个列表入口。邮件推送等读者订阅以后再做。
- **补齐 N§3 Technology 的编辑产品**：Launch Reality Check、Technology Evolution Timeline。Technology 是目前唯一有数据的板块。

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

## 钱与开关（金额已向使用者说明）

- 新增的读者功能和信源会让花费明显上升。**建议**每日上限从 $2 提到 $8：`gateway` $7.50，`workers_ai` $0.50。
  这是 ainews-design 的建议，使用者已表示"全部采纳"，但在改 `budget.caps` 的生产写入之前再请使用者确认一次金额。
- 所有新的 write 和 reason 调用，做一次批量真实探测，确认 `finishReason=STOP`，预计花费不超过 $0.10。
- `DISCOVERY_ENABLED` 保持 `"false"`。重新打开之前要先满足：probe 遵守 crawl-delay、带项目 UA、跨主机查 robots；
  有当天预算；websearch 经过 `createModelClient` 记账。改这个开关仍然要单独开 PR，并经使用者同意。

## 流程

- 每个 PR 合并前，在 GitHub 上留两路评审的评论，适用时标 [degraded]。合并用 `--match-head-commit`，绑定评审过的 head。
- #23 和 #24 的 0020 迁移号冲突：后合并的一方 rebase 后，重新运行 `db:generate`。
- 5 个 `/private/tmp/ainews-review-*` worktree 的内容 main 上都已经有了，用 `git worktree remove` 清理。

## 仍需使用者亲手做

- 在 `ioenv.com` 上接好 Email Service，并确认发件地址。
- 提供能读 AI Gateway 日志的凭据，用于 M1 关口的对账，并确认 embed 的计费渠道。
- 确认每日预算的金额（建议 $8）。
