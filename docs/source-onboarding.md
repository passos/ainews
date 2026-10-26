# 信源候选与 owner 接入规程

**已验证（代码基线 cab0433）**：只有两条Technology种子源；primary_domains是抓取允许范围，既不是sources行也不是新源许可。**假设（提案）**：下表新源等待root的官方一手研究及owner批准。**未知**：实时URL、robots、HTTP、正文、条款和生产状态。本单元不访问官网，不新增/激活源、不改seed/阈值/白名单/开关；不得把候选写成“已存在真实feed”。

| 板块 | 已有seed配置（非生产证明） | 提案入口与候选范围 | 差异/批准状态 |
|---|---|---|---|
| Technology | arXiv cs.AI `https://rss.arxiv.org/rss/cs.AI`、siteDomain arxiv.org、summaryIsBody=true、排replace/replace-cross；MIT TR `https://www.technologyreview.com/topic/artificial-intelligence/feed/`、siteDomain technologyreview.com、排sponsored | 沿用既有两条；授权reader查真实source行与health | 既有seed；不重复seed，不把arXiv全文摘要策略复制给普通摘要feed |
| Education | primaryDomains ed.gov、nces.ed.gov；无seed源 | [Education Newsroom](https://www.ed.gov/about/news)官方新闻/press releases；[NCES](https://nces.ed.gov/)报告/新闻为备选 | 提案待研究/审批；无已验证RSS URL或CSS selector，不猜/feed |
| Industry | primaryDomains sec.gov；无seed源 | [NIST RSS目录](https://www.nist.gov/coo/nist-rss-feeds)的Manufacturing候选；[Manufacturing](https://www.nist.gov/manufacturing)领域入口，备选NIST News | 提案待研究/审批；nist.gov新增域需专门白名单review |
| Finance | primaryDomains sec.gov、finra.org、federalreserve.gov；无seed源 | [Fed RSS目录](https://www.federalreserve.gov/feeds/feeds.htm)的All Press Releases候选；备选[SEC RSS目录](https://www.sec.gov/files/about/secrss.shtml) | 提案待研究/审批；目录不是已核实feed；Fed不代替#22 EDGAR，也不覆盖#23全部创业融资报道 |

上述入口来自既有planning线索，不是本单元验证。2026-10-26 一次官方目录观察：Fed与SEC的RSS目录页可读，但点击实际feed未验证；一次web请求 ed.gov news 返回403、nces.ed.gov/whatsnew 超时，只证明那次请求失败，不是官方站永久不可抓或项目UA同样失败。以上仍是proposed dossier，未激活，不是可启用证明；项目UA下的feed、robots和正文梯结果均未知，不据此转浏览器渲染或加域名。SEC tracked company不自动算普通sources源。canonical_url全局唯一，同一报道不能同时填Industry/Finance，owner先定归属。Finance始终人工review，页面与RSS保留Not investment advice；不新增投资建议。

## Remote-read-only：root授权 reader 的一手研究

每候选最多官方目录、robots、feed/列表和两篇正文样本；优先Education、Fed、NIST各一个。不带生产secret、不调用模型、不写生产；出未审域的redirect先记新host再停，不跟随，不无界搜索。

1. 从官方目录取实际RSS/Atom链接；无RSS再验服务器返回HTML列表。记UTC、最终URL、逐跳host、content-type、解析结果、日期字段、更新节奏、样本URL、条款链接。未知query token或凭证URL不粘贴，拒绝猜端点。
2. 用项目UA `PersonalNewsBot/1.0 (+https://news.ioenv.com)` 核列表及正文robots/crawl-delay；无许可/失败不绕过。现有collect对RSS feed不查robots、对HTML查，不能据此前者就省正文合规核查，本任务不改策略。
3. 两篇正文须不用浏览器/Jina、不越付费墙，满足既有 `isBody` 和2MiB界限，记录body rung。摘要feed不能擅设summaryIsBody；CSS selector必须由真实DOM验证；逐个列正文/跳转host待审。SEC数据继续走已有edgar client。
4. dossier用 `src/pipeline/collect/config.ts` 的strict SourceConfig校验；owner核名单、板块归属、域、频率、阈值与预计增量费用。先保留既有review和门槛，少量candidate。自动discovery策略不构成人工接源授权。

## Local-only：每源 dossier（目前全待填，不能执行）

| 字段 | 每个Education/Industry/Finance候选须补 |
|---|---|
| 身份/输入 | industry、name、kind rss/html、官方目录来源、观察UTC |
| 路径/配置 | 实际feedUrl、siteDomain、所有redirect/body host、intervalMinutes、utcOffset、config及SourceConfig校验结果 |
| 抓取证据 | robots/terms链接与结论、UA/crawl-delay、两篇样本、content-type、body rung、日期解析、无需JS/付费墙证明 |
| 成本/审核 | 预计每天请求量/模型增量预算、现有阈值/噪声规则、域变更、owner具体批准引用/日期 |
| 状态 | proposed → verified research → owner-approved → candidate → separately activated；每步独立证据 |

当前这些字段均**未知/待研究**，不预填RSS或selectors，不把proposal升级成真实feed。root可完成研究后按同表提交owner；代码实现不等待这项运营动作。

## Owner-mutation：手工接源、激活、暂停

已有Access后台 `createSource`（POST）写的是 `sources.status='candidate'`；`approveCandidate`读另一张 `source_candidates` 表，不能把手工source id传入。`resumeSource`现有受保护POST可激活sources，但UI仅给paused显示Resume，不能声称手工candidate已有完整UI闭环，也不打开discovery绕过。
推荐owner审定单行条件SQL和前后计数；备选授权operator用现有Access保护resumeSource（先核id/状态，不猜server function id）；或#9 follow-up补UI（延期）。未定渠道只查SELECT。暂停也未核到通用后台helper，不发明接口、不删历史。

以下只是待审绑定模板，**不能直接粘贴Wrangler**。参数须来自具体批准dossier及真实SELECT；owner先选支持绑定的受控渠道，或审定已替换具体值的绝对路径SQL文件，再执行一次。?1不是已绑定的source id。

```sql
-- Owner-approved activation, expected affected rows = 1.
UPDATE sources SET status='active' WHERE id=?1 AND industry_id=?2 AND status='candidate';
-- Owner-approved pause, expected affected rows = 1.
UPDATE sources SET status='paused',paused_reason=NULL WHERE id=?1 AND industry_id=?2 AND status='active';
```

前查目标id/industry/status/count，后用独立只读查询核id/status/count，影响0或多行就停；一次一个批准source，不全表candidate UPDATE。激活保留interval/config，调度会产生模型费用，须有预计增量预算批准；暂停不动正文/审核历史。真实采集、分析、当前body人工批准和公共输出由root观察，失败留固定health类别，不自动补队/降阈值/切auto/开Jina/换广域聚合源。

owner可选上述候选经研究再批准（推荐）、指定替代或维持空板块；后者不阻塞本地代码但M4不能验收。门槛推荐沿用，变更另审；新增Industry域与激活渠道各有具体批准。四板块需各有active真实源、当期成功和当前人工批准文章、section/RSS非空；一次last_ok_at不能证明持续24h。详见[部署与证据关口](deploy.md)，无原件仍标未知。
