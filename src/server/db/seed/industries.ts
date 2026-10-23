// Seed data of the four sections (#8). The criteria are DRAFTS: AGENTS.md says
// the owner decides what is important, what is noise and how a section is
// divided. Nothing here is code logic. It is stored as JSON in
// industries.config and read back by parseAnalysisConfig (analyze/config.ts).
//
// Weights are integers that add up to 10 per content type. Technology uses
// the 7 rows of AIHOT industry/prompts/selection-score.md. The other three
// are new drafts with the same shape. Noise caps are on the 0-10 scale.
//
// Every string stays on one line (JSON.stringify), so the seed SQL keeps one
// statement per line.
import { FINANCE_SLUG } from "../../../pipeline/analyze/analyze";
import type { AnalysisConfig } from "../../../pipeline/analyze/config";

export interface SeedIndustry {
  slug: string;
  name: string;
  /** Every section starts in review mode (architecture section 7). */
  publishMode: "review";
  disclaimer: string | null;
  /** Domains the pipeline may trace a story back to. The owner confirms. */
  primaryDomains: string[];
  analysis: AnalysisConfig;
}

/**
 * Owner decision of 2026-10-23: `select` is 60 for Technology (arXiv alone
 * would send about 140 articles a day to the queue at 50) and 50 for the
 * others; recalibrate after a week with the owner's labelled samples.
 */
const thresholds = (select: number) => ({ prefilterMinRelevant: 0.3, select });

const technology: AnalysisConfig = {
  prefilter: {
    relevant:
      "Material about AI or computing technology with a concrete subject, such as a model, product, developer tool, research result, benchmark, open-source release, security issue or technical method, where the text shows who did what.",
    off_topic:
      "Material about other fields such as sports, entertainment, politics, general business or science outside computing, where technology is only a passing mention.",
    noise:
      "Promotion and filler, such as sponsored content, customer success stories, event or course ads, job posts, newsletters and roundups with no single focus, and teasers with no substance.",
  },
  categories: {
    models_and_research:
      "New models, model updates, research papers, benchmarks and technical reports.",
    products_and_tools:
      "Products, developer tools, APIs, open-source projects and platform features that people can use.",
    infrastructure_and_hardware:
      "Chips, data centers, cloud and serving infrastructure, and the cost and energy needed to run AI.",
    safety_and_security:
      "Security flaws, attacks, safety and alignment findings, and reliability failures.",
    applications_and_impact:
      "How AI and software are used in science, health, media, work and daily life, and what changes because of it.",
    other_technology:
      "Other computing technology that does not fit the categories above.",
  },
  contentTypes: {
    model_release: {
      description: "A new model or a major version update of a model.",
      weights: { sig: 3, nov: 2, cred: 2, reson: 2, act: 1 },
    },
    product_launch: {
      description: "A new product, tool or major feature update.",
      weights: { sig: 2, nov: 2, cred: 1, reson: 2, act: 3 },
    },
    tool_or_prompt: {
      description:
        "A method, prompt, skill or technique that readers can reuse directly.",
      weights: { sig: 1, nov: 2, cred: 1, reson: 2, act: 4 },
    },
    research_paper: {
      description: "A paper, research result or technical report.",
      weights: { sig: 5, nov: 3, cred: 1, reson: 0, act: 1 },
    },
    industry_event: {
      description:
        "Funding, acquisition, regulation, lawsuit, business move or personnel change.",
      weights: { sig: 3, nov: 1, cred: 2, reson: 4, act: 0 },
    },
    opinion_analysis: {
      description:
        "An opinion, an industry judgment, a retrospective or a long interview.",
      weights: { sig: 1, nov: 3, cred: 1, reson: 4, act: 1 },
    },
    tutorial_explainer: {
      description:
        "A tutorial, an explainer, a plain-language reading or a review.",
      weights: { sig: 1, nov: 1, cred: 1, reson: 3, act: 4 },
    },
  },
  dimensions: {
    sig: [
      "A footnote of the day: a routine fix, a minor version, a repeated announcement or a restatement of known facts.",
      "A small step: a useful but narrow improvement that matters to one tool, one benchmark or one small group of users.",
      "A solid development: a notable release, result or change that practitioners in one area should know this month.",
      "A node on the timeline: a change in what many developers or organizations can do, or in how they choose.",
      "A turning point: a first of its kind, or a field-wide shift in capability, cost, access or safety that later events will refer back to.",
    ],
    nov: [
      "Nothing new: it repeats earlier reports, a press release without new facts, or a rewrite of known material.",
      "A small new detail added to a known story, such as a version number, a date or a partner name.",
      "One clear new fact, result or method that the reader could not have learned from earlier coverage.",
      "Several new facts, or a new method shown with evidence, that change part of what the reader understood before.",
      "A new finding or capability that contradicts or reshapes the common understanding of the topic.",
    ],
    cred: [
      "Only a claim: no evidence, no data, no method, or a source that cannot be traced.",
      "Mostly an assertion by the vendor or the author, with a few figures, no independent check and no method.",
      "The core facts are clear and the source is direct, such as a release note or a paper abstract, but effects and comparisons are asserted and not shown.",
      "The core facts are supported by data, a method or a reproducible artifact inside the material, and the limits are stated.",
      "The core facts are supported by independent checks or several consistent sources, such as third-party evaluation, released code and data, or an official record.",
    ],
    reson: [
      "Concerns a very small expert group, and the reader needs special background to see why it matters.",
      "Interests specialists in one subfield. Other technology readers would skip it.",
      "Interests many working developers, students or product people in one area.",
      "Touches the tools, jobs or studies of most readers of this section, or is easy to explain as surprising.",
      "Almost every reader of this section sees why it matters to them and would pass it on.",
    ],
    act: [
      "Nothing to do with it: pure news or theory with no use for the reader's choices.",
      "Background to keep in mind. It may inform a later decision, with no step to take now.",
      "Helps the reader to choose between options or to understand a concept, but needs more work before use.",
      "The reader can try or adopt it soon: a tool, method or finding with enough detail to start.",
      "The reader can use it right away: concrete steps, code, settings or a decision rule that still works outside one vendor's platform.",
    ],
  },
  noise: {
    none: {
      description:
        "Not noise: the material reports a real event, result, method or explanation.",
      caps: {},
    },
    customer_pr: {
      description:
        "A customer case or a partnership blurb with no stated task, scale, cost, time, quality or method that others can reuse.",
      caps: { sig: 4 },
    },
    minor_update: {
      description:
        "A routine small release, a language or region rollout, a port to another platform, narrow SDK support or an ordinary fix.",
      caps: { sig: 3 },
    },
    marketing: {
      description:
        "An advertorial, sponsored content, a course or event promotion, a job post, a free-trial offer or a vague roadmap.",
      caps: { sig: 2 },
    },
    teaser: {
      description:
        "Only a teaser, early access or a coming-soon notice, with no concrete specification or checkable content.",
      caps: { nov: 3, cred: 4 },
    },
    anecdote: {
      description:
        "One person's second-hand impression such as faster, stronger or amazing, with no data, method or change in availability.",
      caps: { nov: 3, sig: 4 },
    },
    roundup: {
      description:
        "A news digest, newsletter or weekly roundup that packs many events and has no single focus.",
      caps: { sig: 3 },
    },
    vendor_howto: {
      description:
        "A how-to that only teaches the vendor's own platform, with no general method that still holds outside it.",
      caps: { sig: 3 },
    },
    narrow_method: {
      description:
        "A pure training trick, a small architecture change, a low-level optimization, quantization, a retrieval or protocol tweak, a gain on one benchmark, or a small method gain in a narrow field.",
      caps: { sig: 4, reson: 3 },
    },
  },
  labels: ["publication_status", "development_stage", "claim_mode"],
  thresholds: thresholds(60),
  summaryGuidance:
    "Say what was released, found or announced and by whom, keep the source's own claims apart from independent evaluation, and for a paper say whether it is a preprint or a peer-reviewed publication, as the material states, and name the main limit the authors state.",
  guardrails: [],
};

const education: AnalysisConfig = {
  prefilter: {
    relevant:
      "Material about education, such as policy and funding, curriculum and standards, research on teaching and learning, education technology and AI in schools, higher education and access to learning, where the text names a decision, a study, a statistic or a product.",
    off_topic:
      "Material where schools or students appear only in passing, such as general youth news, campus sports or celebrity news, and technology news with no teaching or learning angle.",
    noise:
      "Promotion and filler, such as school or tool marketing, enrolment and fundraising ads, generic study-tip lists, event notices, and roundups with no single focus.",
  },
  categories: {
    policy_and_funding:
      "Laws, regulations, guidance and budgets that govern schools, colleges and training.",
    research_and_evidence:
      "Studies, surveys and statistical reports on how people learn and what works in teaching.",
    tools_and_ai_in_learning:
      "Education technology, AI tutors and classroom tools, and how schools and learners use them.",
    curriculum_and_teaching_practice:
      "Curriculum changes, AI literacy, assessment and classroom methods that teachers can apply.",
    higher_education_and_access:
      "Colleges, admissions, costs, degrees, skills training and access to learning opportunities.",
    school_system_and_workforce:
      "Enrolment, staffing, school climate, and the working conditions of teachers and school leaders.",
  },
  contentTypes: {
    policy_change: {
      description:
        "A new or changed law, rule, guidance, funding decision or court ruling that governs education.",
      weights: { sig: 4, nov: 1, cred: 2, reson: 2, act: 1 },
    },
    research_study: {
      description:
        "A study, survey or statistical release with data on learners, teachers or schools.",
      weights: { sig: 2, nov: 3, cred: 3, reson: 1, act: 1 },
    },
    tool_or_product: {
      description:
        "A new education tool, product or program, or a report on how one is used.",
      weights: { sig: 2, nov: 2, cred: 2, reson: 1, act: 3 },
    },
    practice_explainer: {
      description:
        "A guide, explainer or example of a teaching or study method that readers can apply.",
      weights: { sig: 1, nov: 2, cred: 1, reson: 2, act: 4 },
    },
    opinion_analysis: {
      description:
        "An opinion, an analysis or a retrospective about education policy or practice.",
      weights: { sig: 1, nov: 3, cred: 2, reson: 3, act: 1 },
    },
  },
  dimensions: {
    sig: [
      "A local or one-off item: one school, one event, or a repeat of a known fact.",
      "A change that affects one school, one district or one small program.",
      "A change or finding that matters to a whole state, a large district, a subject area or a type of school.",
      "A national policy, a large study or a widely used product that changes what many schools or colleges do.",
      "A shift in how education works for a country or a generation, such as a major law, a landmark study, or new access for millions of learners.",
    ],
    nov: [
      "Nothing new: it repeats known policy or findings, or restates a press release.",
      "A small update to a known story, such as a new date, figure or place.",
      "One clear new finding, rule or example that earlier coverage did not give.",
      "New data or a new rule with detail on who it covers, which changes part of what readers believed.",
      "A new result or decision that contradicts or reshapes the common view of what works in education.",
    ],
    cred: [
      "A bare claim: no data, no source, no stated population and no stated outcome.",
      "Promotional or anecdotal: testimonials, vendor figures or one classroom story, with no comparison group.",
      "The facts are clear and the source is direct, such as an agency notice or a survey summary, but the design, sample or measures are not given.",
      "Data with a stated sample, population and outcome measure, and the limits are admitted.",
      "A strong design is described: a comparison group or random assignment, a large or representative sample, and learning measured beyond speed or satisfaction. Or the text is the official record of the rule itself.",
    ],
    reson: [
      "Only specialists in education research or administration would see why it matters.",
      "Matters to one group, such as school administrators or the teachers of one subject.",
      "Matters to many teachers, or to students at one level such as primary, secondary or college.",
      "Matters to most educators and to many students and parents because it touches grades, cost, time or safety in school.",
      "Almost every student, educator or parent sees how it concerns them and would talk about it.",
    ],
    act: [
      "Nothing to do with it: background or news with no step for a learner or an educator.",
      "Worth keeping in mind for a later choice, with no step to take now.",
      "Helps an educator or a student to compare options or to read a claim critically.",
      "A teacher, student or school can try it soon: a method, tool or guide with enough detail to start.",
      "Ready to use in class or in study right away: concrete steps, materials or a checklist that does not need one product.",
    ],
  },
  noise: {
    none: {
      description:
        "Not noise: the material reports a real decision, study, statistic, product or method.",
      caps: {},
    },
    tool_promotion: {
      description:
        "Product or school marketing, or vendor claims of learning gains with no comparison group and no measured outcome.",
      caps: { sig: 3, cred: 3 },
    },
    event_or_fundraising: {
      description:
        "An event notice, an enrolment or fundraising ad, an award list, a ceremony or routine school-board business.",
      caps: { sig: 2 },
    },
    generic_tips: {
      description:
        "A list of study tips, back-to-school advice or general learning advice with nothing specific.",
      caps: { sig: 3, nov: 3 },
    },
    roundup: {
      description:
        "A news digest or newsletter that packs many items and has no single focus.",
      caps: { sig: 3 },
    },
    single_anecdote: {
      description:
        "One teacher's, student's or parent's story presented as proof that a method or tool works.",
      caps: { sig: 4, cred: 3 },
    },
    speculation: {
      description:
        "A prediction of how AI will change education, with no new fact, data or case.",
      caps: { sig: 4, cred: 3 },
    },
  },
  labels: [
    "publication_status",
    "study_population",
    "outcome_measure",
    "claim_mode",
  ],
  thresholds: thresholds(50),
  summaryGuidance:
    "Name the group that a policy or study covers, say for a study who took part and what was measured, and do not suggest that the result applies to other groups.",
  guardrails: [],
};

const industry: AnalysisConfig = {
  prefilter: {
    relevant:
      "Material about companies and industries, such as company strategy and results, supply chains, funding and deals, regulation, market trends and the adoption of technology, where a named actor takes a concrete action or gives a figure.",
    off_topic:
      "Material with no business or industry content, such as consumer gossip, personal finance tips, general politics, or science with no economic angle.",
    noise:
      "Promotion and filler, such as press-release boilerplate, award and ranking lists, event notices, sponsored content, and roundups with no single focus.",
  },
  categories: {
    company_strategy:
      "Moves by named companies, such as products, partnerships, leadership changes, restructuring and plans.",
    supply_chain_and_operations:
      "Suppliers, manufacturing capacity, logistics, sourcing and disruptions.",
    funding_and_deals:
      "Funding rounds, acquisitions, mergers and investments in facilities, with stated value or terms.",
    regulation_and_trade:
      "Laws, rules, tariffs, export controls, standards and court decisions that change how an industry operates.",
    market_and_adoption:
      "Demand, pricing, market share, and how widely companies adopt a technology.",
    workforce_and_skills:
      "Jobs, hiring, skills and training changes in an industry.",
  },
  contentTypes: {
    company_move: {
      description:
        "A named company announces or carries out a product, partnership, restructuring, leadership or strategy move.",
      weights: { sig: 3, nov: 2, cred: 2, reson: 2, act: 1 },
    },
    supply_chain: {
      description:
        "Capacity, sourcing, logistics or supplier changes, or a disruption in a supply chain.",
      weights: { sig: 4, nov: 2, cred: 2, reson: 1, act: 1 },
    },
    funding_or_deal: {
      description:
        "A funding round, acquisition, merger, joint venture or large investment, with parties and terms.",
      weights: { sig: 3, nov: 1, cred: 3, reson: 2, act: 1 },
    },
    regulation: {
      description:
        "A law, rule, tariff, export control, standard or court decision that changes how companies operate.",
      weights: { sig: 4, nov: 2, cred: 2, reson: 1, act: 1 },
    },
    market_trend: {
      description:
        "Data or analysis on demand, prices, market share or technology adoption across companies.",
      weights: { sig: 2, nov: 3, cred: 2, reson: 2, act: 1 },
    },
    opinion_analysis: {
      description:
        "An opinion, an analysis or an interview that interprets industry developments.",
      weights: { sig: 1, nov: 3, cred: 2, reson: 3, act: 1 },
    },
  },
  dimensions: {
    sig: [
      "A routine item: a minor update from a small company, a footnote in results, or a repeat of known news.",
      "Matters to one company or to one small segment.",
      "Matters to one industry segment: a notable move by a sizable company, or a deal or rule with real money or capacity behind it.",
      "Shifts the plans of several companies or of a whole industry: large capacity, a major deal or a rule that takes effect.",
      "Reorders an industry or its supply chain: a change in who can make, sell or buy something at large scale, with stated numbers and dates.",
    ],
    nov: [
      "Nothing new: it repeats earlier announcements.",
      "A small new detail, such as a date or a partner name.",
      "One clear new fact, such as a figure, date, partner or rule that earlier coverage lacked.",
      "Several new facts that together change the picture of a company or a market.",
      "A new fact that contradicts the prevailing view of a company, supplier or market.",
    ],
    cred: [
      "Only a rumor or an unnamed source, with no figures.",
      "A claim by one party with vague figures and no documents.",
      "A direct statement by the actor, such as a company release, with names and numbers, but plans and projections are written as if they were certain.",
      "Facts backed by documents such as filings, contracts or agency notices, or by statements from both sides, and plans are labeled as plans.",
      "Facts confirmed by independent sources or official records, and the text reports outcomes such as output or deliveries, not only intentions.",
    ],
    reson: [
      "Only people inside one niche firm would care.",
      "Interests analysts of one segment.",
      "Interests professionals in one industry.",
      "Interests professionals across several industries, or the customers and suppliers of the firms involved.",
      "Concerns most working professionals through jobs, prices, skills or the tools they use.",
    ],
    act: [
      "Nothing to do with it.",
      "Background for planning, with no question to follow up.",
      "Raises a question that a professional should investigate before acting.",
      "Gives enough detail to compare options, such as dates, volumes, prices or eligibility.",
      "A clear action or deadline for a professional: a rule to comply with, a supplier or program to evaluate, or a skill to train.",
    ],
  },
  noise: {
    none: {
      description:
        "Not noise: the material reports a real action, figure, rule or analysis.",
      caps: {},
    },
    customer_pr: {
      description:
        "A customer case study or a partnership blurb with no stated scale, value, date or result.",
      caps: { sig: 4 },
    },
    vague_roadmap: {
      description: "Plans or ambitions with no figure, date or commitment.",
      caps: { nov: 3, cred: 3 },
    },
    marketing: {
      description:
        "An advertorial, sponsored content, an event promotion or a job post.",
      caps: { sig: 2 },
    },
    ranking_or_award: {
      description:
        "A ranking, award list or recognition with no business consequence.",
      caps: { sig: 2 },
    },
    roundup: {
      description:
        "A news digest or newsletter that packs many items and has no single focus.",
      caps: { sig: 3 },
    },
    unconfirmed_report: {
      description:
        "A forecast or rumor about a deal or move that no party has confirmed.",
      caps: { sig: 4, cred: 3 },
    },
  },
  labels: ["development_stage", "claim_mode"],
  thresholds: thresholds(50),
  summaryGuidance:
    "Say which company or regulator did what, give the figures and dates that the source gives, and mark plans, targets and projections as such.",
  guardrails: [],
};

const finance: AnalysisConfig = {
  prefilter: {
    relevant:
      "Material about finance with a concrete, documented event, such as earnings and filings, actions by regulators and central banks, funding rounds, or how financial firms use AI, including research with a stated method.",
    off_topic:
      "Material with no finance event or concept, such as general business or technology news, shopping advice and political commentary.",
    noise:
      "Price moves and market chatter, stock tips, promotion of trading signals, sponsored investment content, and market wrap-ups with no single event.",
  },
  categories: {
    earnings_and_filings:
      "Earnings releases and calls, annual and quarterly filings, guidance and other company disclosures.",
    regulation_and_enforcement:
      "Rules, guidance and enforcement actions from the SEC, FINRA, bank regulators and other authorities.",
    central_banks_and_macro:
      "Central-bank decisions, minutes, rates and official economic data releases.",
    funding_and_deals:
      "Venture and private funding rounds, acquisitions and IPO filings, from public announcements.",
    ai_in_finance:
      "How banks, funds, insurers and fintech firms build and use AI, and research on AI in markets.",
    finance_concepts:
      "Explainers of finance concepts such as backtesting, overfitting, drawdown, dilution and term sheets.",
  },
  contentTypes: {
    earnings_or_filing: {
      description:
        "An earnings release, earnings call, annual or quarterly filing, or guidance update from a company.",
      weights: { sig: 3, nov: 2, cred: 3, reson: 1, act: 1 },
    },
    regulatory_action: {
      description:
        "A rule, guidance, enforcement action, approval or decision from a regulator or a central bank.",
      weights: { sig: 4, nov: 2, cred: 2, reson: 1, act: 1 },
    },
    funding_round: {
      description:
        "A funding round, IPO filing or acquisition announced by a company or investor, with parties and amounts.",
      weights: { sig: 2, nov: 2, cred: 3, reson: 2, act: 1 },
    },
    ai_in_finance_claim: {
      description:
        "A claim, study or announcement about how AI performs or is used in finance, including backtests and live deployments.",
      weights: { sig: 2, nov: 2, cred: 4, reson: 1, act: 1 },
    },
    concept_explainer: {
      description:
        "An explainer that teaches a finance concept or shows how to read a filing or a claim.",
      weights: { sig: 1, nov: 1, cred: 2, reson: 2, act: 4 },
    },
    opinion_analysis: {
      description:
        "An opinion or analysis that interprets finance developments, with or without data.",
      weights: { sig: 1, nov: 3, cred: 3, reson: 2, act: 1 },
    },
  },
  dimensions: {
    sig: [
      "A footnote: a routine filing, a small price move or a repeat of known events.",
      "Matters to one company or one small market.",
      "A notable event for one sector, such as a mid-size funding round, a routine enforcement action, or an earnings result that changes guidance.",
      "Matters across a sector or the market: a large filing or result, a new rule, or a major action against a large institution.",
      "A market-wide or system-wide event, such as a central-bank decision, a major rule change, a large failure or a landmark ruling.",
    ],
    nov: [
      "Nothing new: it repeats known results or earlier news.",
      "A small new detail, such as a number or a date.",
      "One clear new fact from a document that earlier coverage lacked.",
      "Several new facts that change what readers understood about a company, a rule or a claim.",
      "A new finding that contradicts a widely held view or an earlier claim.",
    ],
    cred: [
      "A claim with no source, no period and no method, or a rumor.",
      "A promotional claim or a press-release figure with no document, benchmark or period.",
      "The facts come from the actor's own statement or a headline result, but the period, benchmark or costs are not given.",
      "The figures are tied to a filing, a transcript, a regulator document or a stated method, and the period and benchmark are shown.",
      "The facts come from an official record or a documented live record, with period, benchmark and costs, and the authors state their own limits. A backtest or a simulation does not reach this tier.",
    ],
    reson: [
      "Only specialists in one niche would care.",
      "Interests professionals in one sector.",
      "Interests finance professionals and founders in general.",
      "Interests investors, founders and finance students in general because it touches rules they follow or money they handle.",
      "Almost any reader sees why it matters, for example rates, bank rules or a failure that touches ordinary savers.",
    ],
    act: [
      "Nothing to do with it.",
      "Background for later study.",
      "Helps the reader to understand how a rule, a filing or a claim works.",
      "The reader can use it to check a similar claim or filing.",
      "The reader can use it right away to learn a concept, to comply with a rule or to check a claim, with steps, definitions and where to look in the filings. It never means a trade.",
    ],
  },
  noise: {
    none: {
      description:
        "Not noise: the material reports a documented event, a result with a stated method, or an explanation.",
      caps: {},
    },
    price_move: {
      description:
        "Daily price or index moves, stock tips, analyst target changes and market chatter with no underlying event.",
      caps: { sig: 2 },
    },
    ai_washing_claim: {
      description:
        "A claim of AI capability or AI performance with no method, period, benchmark or independent check, like the AI washing that the SEC has penalized.",
      caps: { cred: 3 },
    },
    trading_promotion: {
      description:
        "Promotion of trading signals, bots, courses or investment products.",
      caps: { sig: 2, cred: 2 },
    },
    market_wrap: {
      description:
        "A market wrap-up or newsletter with many events and no single focus.",
      caps: { sig: 3 },
    },
    unconfirmed_report: {
      description:
        "A deal or earnings rumor from unnamed sources that no party has confirmed.",
      caps: { nov: 3, cred: 2 },
    },
    routine_pr: {
      description:
        "Routine company PR such as awards, product blurbs and appointments, with no financial event.",
      caps: { sig: 3 },
    },
  },
  labels: ["performance_basis", "development_stage", "claim_mode"],
  thresholds: thresholds(50),
  summaryGuidance:
    "Say what was reported or decided, give the figures as the source gives them together with their period, and say whether a result comes from a backtest, a simulation or live use, with the benchmark it is compared with and the source of the figures when the source gives them.",
  guardrails: [
    "Never give buy, sell or hold advice, price targets, portfolio recommendations or personal investment advice.",
    "Never state or suggest that an AI agent can reliably beat the market.",
    "Never present a forecast, projection or target as a fact.",
    "Always say whether a performance claim comes from a backtest, a simulation or live use, and give the period, the benchmark it is compared with, and the source, when the source gives them.",
  ],
};

export const SEED_INDUSTRIES: SeedIndustry[] = [
  {
    slug: "technology",
    name: "Technology",
    publishMode: "review",
    disclaimer: null,
    primaryDomains: ["arxiv.org"],
    analysis: technology,
  },
  {
    slug: "education",
    name: "Education",
    publishMode: "review",
    disclaimer: null,
    primaryDomains: ["ed.gov", "nces.ed.gov"],
    analysis: education,
  },
  {
    slug: "industry",
    name: "Industry",
    publishMode: "review",
    disclaimer: null,
    primaryDomains: ["sec.gov"],
    analysis: industry,
  },
  {
    slug: FINANCE_SLUG,
    name: "Finance",
    publishMode: "review",
    disclaimer: "For information and education only. Not investment advice.",
    primaryDomains: ["sec.gov", "finra.org", "federalreserve.gov"],
    analysis: finance,
  },
];
