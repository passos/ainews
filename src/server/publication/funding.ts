// Public read layer of the Funding Round Tracker (#23). Plain functions that
// take `db`; api.ts and the tests both call them. Numbers shown here are
// counts and sums of reported facts. Nothing ranks or rates a startup.
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { convertToMicroUsdExact } from "../../lib/funding/normalize";
import { safeHttpUrl } from "../../lib/url";
import { approvedArticleWhere, type Db } from "./articles";

export const FUNDING_PAGE_SIZE = 20;
const TOP_INVESTORS = 10;

/** Current approved evidence is required for both facts and aggregates. */
const approvedFundingSource: SQL = sql`EXISTS (
  SELECT 1 FROM json_each(f.source_articles) source
  JOIN articles a ON a.id = json_extract(source.value, '$.articleId')
  WHERE a.body_sha = json_extract(source.value, '$.bodySha')
    AND ${approvedArticleWhere}
)`;

/** The table must be aliased f. Superseded facts never remain active. */
export const publishedFundingWhere: SQL = sql`(
  f.status = 'published' AND f.superseded_by IS NULL
  AND ${approvedFundingSource}
)`;

export interface FundingFilter {
  sector?: string;
  stage?: string;
  investor?: string;
  page?: number;
}

export interface FundingRoundItem {
  id: number;
  companyName: string;
  roundName: string;
  stage: string;
  sector: string;
  amount: number | null;
  currency: string;
  amountMicros: string | null;
  valuation: number | null;
  investors: string[];
  leadInvestors: string[];
  announcedDate: string | null;
  sources: { articleId: number; url: string; title: string }[];
  corrections: { body: string; createdAt: number }[];
}

export interface FundingList {
  items: FundingRoundItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FundingTrends {
  roundCount: number;
  bySector: {
    sector: string;
    rounds: number;
    disclosedRounds: number;
    convertedRounds: number;
    totalMicros: string;
  }[];
  byStage: { stage: string; rounds: number }[];
  /** Investors by number of rounds they took part in. A count, not a score. */
  investorActivity: { name: string; rounds: number }[];
}

interface RoundRow {
  id: number;
  company_name: string;
  round_name: string;
  stage: string;
  sector: string;
  amount: number | null;
  currency: string;
  amount_micros: number | null;
  valuation: number | null;
  investors: string;
  lead_investors: string;
  announced_date: string | null;
  source_articles: string;
}

function strings(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function filterSql(f: FundingFilter): SQL {
  const parts: SQL[] = [publishedFundingWhere];
  if (f.sector) parts.push(sql`f.sector = ${f.sector}`);
  if (f.stage) parts.push(sql`f.stage = ${f.stage}`);
  if (f.investor) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM json_each(f.investors) j
      WHERE lower(j.value) = lower(${f.investor})
    )`);
  }
  return sql.join(parts, sql` AND `);
}

export async function getPublishedFundingRounds(
  db: Db,
  filter: FundingFilter = {},
): Promise<FundingList> {
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const where = filterSql(filter);

  const [count] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM funding_rounds f WHERE ${where}`,
  );
  const rows = await db.all<RoundRow>(sql`
    SELECT f.id, f.company_name, f.round_name, f.stage, f.sector, f.amount,
           f.currency, f.amount_micros, f.valuation, f.investors,
           f.lead_investors, f.announced_date, f.source_articles
    FROM funding_rounds f
    WHERE ${where}
    ORDER BY COALESCE(f.announced_date, '') DESC, f.id DESC
    LIMIT ${FUNDING_PAGE_SIZE} OFFSET ${(page - 1) * FUNDING_PAGE_SIZE}`);

  return {
    total: count?.n ?? 0,
    page,
    pageSize: FUNDING_PAGE_SIZE,
    items: await hydrateRounds(db, rows),
  };
}

async function hydrateRounds(
  db: Db,
  rows: RoundRow[],
): Promise<FundingRoundItem[]> {
  // A source is listed only while its article is still approved.
  const articleIds = new Set<number>();
  const parsedSources = new Map<
    number,
    { articleId: number; bodySha: string; url: string; title: string }[]
  >();
  for (const r of rows) {
    let list: {
      articleId: number;
      bodySha: string;
      url: string;
      title: string;
    }[] = [];
    try {
      const v = JSON.parse(r.source_articles);
      if (Array.isArray(v)) list = v;
    } catch {
      /* none */
    }
    parsedSources.set(r.id, list);
    for (const s of list) articleIds.add(Number(s.articleId));
  }
  const approved = new Set<string>();
  if (articleIds.size > 0) {
    const ids = [...articleIds];
    const ok = await db.all<{ id: number; body_sha: string }>(sql`
      SELECT a.id, a.body_sha FROM articles a
      WHERE a.id IN (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})
        AND ${approvedArticleWhere}`);
    for (const o of ok) approved.add(`${o.id}:${o.body_sha}`);
  }

  const corrections = new Map<number, { body: string; createdAt: number }[]>();
  if (rows.length > 0) {
    const found = await db.all<{
      target_id: number;
      body: string;
      created_at: number;
    }>(sql`
      SELECT target_id, body, created_at FROM corrections
      WHERE target_type = 'funding_rounds'
        AND EXISTS (SELECT 1 FROM funding_rounds f WHERE f.id = corrections.target_id
          AND f.status = 'published' AND ${approvedFundingSource})
        AND target_id IN (${sql.join(
          rows.map((r) => sql`${r.id}`),
          sql`, `,
        )})
      ORDER BY created_at DESC, id DESC`);
    for (const c of found) {
      const list = corrections.get(c.target_id) ?? [];
      list.push({ body: c.body, createdAt: c.created_at });
      corrections.set(c.target_id, list);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    companyName: r.company_name,
    roundName: r.round_name,
    stage: r.stage,
    sector: r.sector,
    amount: r.amount,
    currency: r.currency,
    amountMicros:
      r.amount === null
        ? null
        : (convertToMicroUsdExact(r.amount, r.currency)?.toString() ?? null),
    valuation: r.valuation,
    investors: strings(r.investors),
    leadInvestors: strings(r.lead_investors),
    announcedDate: r.announced_date,
    sources: (parsedSources.get(r.id) ?? [])
      .filter((s) => approved.has(`${Number(s.articleId)}:${s.bodySha}`))
      .flatMap((s) => {
        const url = safeHttpUrl(s.url);
        return url
          ? [{ articleId: Number(s.articleId), url, title: String(s.title) }]
          : [];
      }),
    corrections: corrections.get(r.id) ?? [],
  }));
}

export interface FundingRoundDetails extends FundingRoundItem {
  versions: FundingRoundItem[];
}

/** Only an active public ID opens details. Historical rows cannot bypass take-downs. */
export async function getFundingRoundDetails(
  db: Db,
  id: number,
): Promise<FundingRoundDetails | null> {
  const [active] = await db.all<{
    id: number;
  }>(sql`SELECT f.id FROM funding_rounds f
    WHERE f.id = ${id} AND ${publishedFundingWhere}`);
  if (!active) return null;
  const rows = await db.all<RoundRow>(sql`WITH RECURSIVE history(id, depth) AS (
    SELECT ${id}, 0 UNION ALL SELECT p.id, h.depth + 1 FROM funding_rounds p JOIN history h ON p.superseded_by = h.id
  ) SELECT f.* FROM funding_rounds f JOIN history h ON h.id = f.id
    WHERE f.status = 'published' AND ${approvedFundingSource}
    ORDER BY h.depth ASC, f.id DESC`);
  const versions = await hydrateRounds(db, rows);
  const current = versions.find((row) => row.id === id);
  if (!current) return null;
  return {
    ...current,
    versions,
    corrections: versions
      .flatMap((version) => version.corrections)
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

export async function getFundingTrends(
  db: Db,
  filter: FundingFilter = {},
): Promise<FundingTrends> {
  const where = filterSql(filter);
  const [total] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM funding_rounds f WHERE ${where}`,
  );
  const native = await db.all<{
    sector: string;
    amount: number | null;
    currency: string;
  }>(sql`
    SELECT f.sector, f.amount, f.currency FROM funding_rounds f WHERE ${where}`);
  const sectors = new Map<
    string,
    {
      sector: string;
      rounds: number;
      disclosedRounds: number;
      convertedRounds: number;
      total: bigint;
    }
  >();
  for (const row of native) {
    const sector = sectors.get(row.sector) ?? {
      sector: row.sector,
      rounds: 0,
      disclosedRounds: 0,
      convertedRounds: 0,
      total: 0n,
    };
    sector.rounds++;
    if (row.amount !== null) {
      sector.disclosedRounds++;
      const exact = convertToMicroUsdExact(row.amount, row.currency);
      if (exact !== null) {
        sector.convertedRounds++;
        sector.total += exact;
      }
    }
    sectors.set(row.sector, sector);
  }
  const byStage = await db.all<{ stage: string; rounds: number }>(sql`
    SELECT f.stage, count(*) AS rounds
    FROM funding_rounds f WHERE ${where}
    GROUP BY f.stage ORDER BY rounds DESC, f.stage ASC`);
  const investors = await db.all<{ name: string; rounds: number }>(sql`
    SELECT min(j.value) AS name, count(DISTINCT f.id) AS rounds
    FROM funding_rounds f, json_each(f.investors) j
    WHERE ${where}
    GROUP BY lower(j.value)
    ORDER BY rounds DESC, lower(j.value) ASC
    LIMIT ${TOP_INVESTORS}`);

  return {
    roundCount: total?.n ?? 0,
    bySector: [...sectors.values()]
      .sort((a, b) => b.rounds - a.rounds || a.sector.localeCompare(b.sector))
      .map(({ total, ...sector }) => ({
        ...sector,
        totalMicros: total.toString(),
      })),
    byStage,
    investorActivity: investors,
  };
}

export const FUNDING_FALLBACK_DISCLAIMER =
  "For information and education only. Not investment advice.";

export interface FundingPageView {
  /** The Finance section's own disclaimer, so there is one wording. */
  disclaimer: string;
  list: FundingList;
  trends: FundingTrends;
}

export async function getFundingPage(
  db: Db,
  filter: FundingFilter = {},
): Promise<FundingPageView> {
  const [row] = await db.all<{ disclaimer: string | null }>(
    sql`SELECT disclaimer FROM industries WHERE slug = 'finance'`,
  );
  const [list, trends] = await Promise.all([
    getPublishedFundingRounds(db, filter),
    getFundingTrends(db, filter),
  ]);
  return {
    disclaimer: row?.disclaimer || FUNDING_FALLBACK_DISCLAIMER,
    list,
    trends,
  };
}
