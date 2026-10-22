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
