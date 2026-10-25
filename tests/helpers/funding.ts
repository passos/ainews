// Plain-SQL seeding of funding_rounds for the admin and public tests.
import { convertToMicroUsd } from "../../src/lib/funding/normalize";
import { env } from "cloudflare:workers";
import { seedIndustry, seedSource } from "../pipeline/helpers";
import { seedArticle, seedReview } from "../publication/helpers";

export interface RoundSeed {
  company?: string;
  companyKey?: string;
  roundKey?: string;
  stage?: string;
  sector?: string;
  amount?: number | null;
  currency?: string;
  amountMicros?: number | null;
  investors?: string[];
  announcedDate?: string | null;
  status?: "published" | "pending_review" | "rejected";
  supersededBy?: number | null;
  sources?: {
    articleId: number;
    bodySha?: string;
    url: string;
    title: string;
  }[];
  correctionReason?: string | null;
}

let n = 0;

export async function seedRound(r: RoundSeed = {}): Promise<number> {
  n += 1;
  const company = r.company ?? `Company ${n}`;
  const amount = r.amount === undefined ? 1_000_000 : r.amount;
  let sources = r.sources;
  if (sources === undefined) {
    const industry = await env.DB.prepare(
      "SELECT id FROM industries WHERE slug = 'finance'",
    ).first<{ id: number }>();
    const industryId = industry?.id ?? (await seedIndustry("finance"));
    const source = await env.DB.prepare(
      "SELECT id FROM sources WHERE industry_id = ?1",
    )
      .bind(industryId)
      .first<{ id: number }>();
    const sourceId =
      source?.id ??
      (await seedSource({
        industryId,
        feedUrl: "https://news.example/funding-fixture-feed",
      }));
    const articleId = await seedArticle({
      industryId,
      sourceId,
      title: "Funding announcement",
      url: `https://news.example/funding-seed-${n}`,
    });
    await seedReview(articleId, "approved");
    sources = [
      {
        articleId,
        url: `https://news.example/funding-seed-${n}`,
        title: "Funding announcement",
      },
    ];
  }
  const boundSources = await Promise.all(
    sources.map(async (source) => {
      const article = await env.DB.prepare(
        "SELECT body_sha FROM articles WHERE id = ?1",
      )
        .bind(source.articleId)
        .first<{ body_sha: string }>();
      return {
        ...source,
        bodySha: source.bodySha ?? article?.body_sha ?? "missing",
      };
    }),
  );
  const row = await env.DB.prepare(
    `INSERT INTO funding_rounds (company_name, company_key, round_name,
       round_key, amount, currency, amount_micros, sector, stage, investors,
       announced_date, source_url, source_articles, status, superseded_by,
       correction_reason, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
       ?16, ?17, ?17) RETURNING id`,
  )
    .bind(
      company,
      r.companyKey ?? company.toLowerCase().replace(/\W+/g, "-"),
      "Series A",
      r.roundKey ?? "series_a",
      amount,
      r.currency ?? "USD",
      r.amountMicros !== undefined
        ? r.amountMicros
        : amount === null
          ? null
          : convertToMicroUsd(amount, r.currency ?? "USD"),
      r.sector ?? "fintech",
      r.stage ?? "series_a",
      JSON.stringify(r.investors ?? []),
      r.announcedDate === undefined ? "2026-10-19" : r.announcedDate,
      "https://news.example/first",
      JSON.stringify(boundSources),
      r.status ?? "pending_review",
      r.supersededBy ?? null,
      r.correctionReason ?? null,
      n,
    )
    .first<{ id: number }>();
  return row!.id;
}
