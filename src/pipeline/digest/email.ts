import { isEnabled } from "../../lib/flags";
import { SITE_NAME } from "../../lib/site";
import type { PipelineEnv } from "../messages";

export interface DigestItemData {
  eventId: number;
  eventRevision?: number;
  title: string;
  /** Approved article summary at build time; absent on rows built before #114. */
  summary?: string;
  /** Model-written one_liner, or null when the model gave none (#114). */
  oneLiner: string | null;
  sourceName: string;
  articleCount: number;
}

export interface DigestEmailData {
  id: number;
  industryId: number;
  industrySlug: string;
  industryName: string;
  kind?: "daily" | "weekly";
  periodStart: string;
  publishedAt: number | null;
  intro: string;
  items: DigestItemData[];
}

export const DEFAULT_EMAIL_FROM = "digest@ioenv.com";

// #114: oneLiner is null when the model wrote none; show the article summary
// instead. Rows built before #114 have no summary and a non-null oneLiner.
function itemLine(item: DigestItemData): string {
  if (item.oneLiner === null || item.oneLiner === "") {
    return item.summary ?? "";
  }
  return item.oneLiner;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatDigestEmail(
  digest: DigestEmailData,
  siteUrl: string,
): { subject: string; text: string; html: string } {
  const isUnpublished = digest.publishedAt === null;
  const isWeekly = digest.kind === "weekly";
  const kindLabel = isWeekly ? "weekly digest" : "daily digest";
  const reviewSuffix = isUnpublished ? " (needs review)" : "";
  const subject = `[${SITE_NAME}] ${digest.industryName} ${kindLabel} — ${digest.periodStart}${reviewSuffix}`;

  const base = siteUrl.replace(/\/+$/, "");
  const digestUrl = `${base}/digest/${digest.industrySlug}/${digest.periodStart}${isWeekly ? "?kind=weekly" : ""}`;
  const adminUrl = `${base}/admin/digests`;

  // Plain text version
  const textLines: string[] = [
    `${SITE_NAME} — ${digest.industryName} ${isWeekly ? "Weekly Digest" : "Daily Digest"}`,
    `${isWeekly ? "Week of: " : "Date: "}${digest.periodStart}`,
    isUnpublished
      ? `Status: Pending Review (Approve at ${adminUrl})`
      : `Status: Published (${digestUrl})`,
    "",
  ];
  if (digest.intro) {
    textLines.push(digest.intro, "");
  }
  textLines.push("Stories:");
  for (const item of digest.items) {
    textLines.push(
      `- ${item.title}`,
      `  ${itemLine(item)}`,
      `  Source: ${item.sourceName} | View: ${base}/e/${item.eventId}`,
      "",
    );
  }
  textLines.push(`Read online: ${digestUrl}`);
  if (isUnpublished) {
    textLines.push(`Review queue: ${adminUrl}`);
  }
  const text = textLines.join("\n");

  // HTML version
  const itemsHtml = digest.items
    .map(
      (item) => `
    <li style="margin-bottom: 16px;">
      <a href="${base}/e/${item.eventId}" style="font-weight: bold; color: #111; text-decoration: underline;">
        ${escapeHtml(item.title)}
      </a>
      <div style="margin: 4px 0; color: #333; font-size: 14px; line-height: 1.5;">
        ${escapeHtml(itemLine(item))}
      </div>
      <div style="font-size: 12px; color: #666; font-family: monospace;">
        Source: ${escapeHtml(item.sourceName)} · ${item.articleCount} report${item.articleCount > 1 ? "s" : ""}
      </div>
    </li>`,
    )
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; color: #111;">
  <header style="border-bottom: 3px solid #111; padding-bottom: 12px; margin-bottom: 16px;">
    <h1 style="font-size: 20px; font-weight: 800; text-transform: uppercase; margin: 0;">
      ${SITE_NAME} — ${escapeHtml(digest.industryName)}
    </h1>
    <div style="font-size: 13px; color: #555; margin-top: 4px;">
      ${isWeekly ? "Weekly Digest" : "Daily Digest"} · ${isWeekly ? "Week of " : ""}${escapeHtml(digest.periodStart)}
      ${isUnpublished ? '<span style="color: #c00; font-weight: bold; margin-left: 8px;">[NEEDS REVIEW]</span>' : ""}
    </div>
  </header>

  ${
    digest.intro
      ? `<div style="background: #f4f4f4; padding: 12px 16px; border-left: 4px solid #333; margin-bottom: 20px; font-size: 15px; line-height: 1.5;">
      ${escapeHtml(digest.intro)}
    </div>`
      : ""
  }

  <ol style="padding-left: 20px; margin-bottom: 24px;">
    ${itemsHtml}
  </ol>

  <footer style="border-top: 1px solid #ddd; padding-top: 12px; font-size: 12px; color: #666;">
    <p>
      <a href="${digestUrl}" style="color: #0066cc;">View on ${SITE_NAME}</a>
      ${isUnpublished ? ` · <a href="${adminUrl}" style="color: #c00; font-weight: bold;">Publish in Admin</a>` : ""}
    </p>
  </footer>
</body>
</html>`;

  return { subject, text, html };
}

export async function sendDigestEmail(
  env: PipelineEnv,
  digestId: number,
  now = Date.now(),
): Promise<void> {
  if (!isEnabled(env, "EMAIL_ENABLED")) {
    return;
  }
  if (!env.EMAIL) {
    return;
  }
  const adminEmail = env.ADMIN_EMAIL;
  if (!adminEmail) {
    return;
  }

  // Claim the digest for emailing atomically (at most once; only for ready digests)
  const claimRes = await env.DB.prepare(
    "UPDATE digests SET emailed_at = ?1 WHERE id = ?2 AND emailed_at IS NULL AND status = 'ready'",
  )
    .bind(now, digestId)
    .run();

  if (claimRes.meta.changes !== 1) {
    return;
  }

  try {
    // Read digest row and industry details
    const row = await env.DB.prepare(
      `SELECT d.id, d.industry_id, d.kind, d.period_start, d.published_at, d.intro, d.items_json,
              i.slug AS industry_slug, i.name AS industry_name
       FROM digests d
       JOIN industries i ON i.id = d.industry_id
       WHERE d.id = ?1 AND d.status = 'ready'`,
    )
      .bind(digestId)
      .first<{
        id: number;
        industry_id: number;
        kind: "daily" | "weekly";
        period_start: string;
        published_at: number | null;
        intro: string;
        items_json: string;
        industry_slug: string;
        industry_name: string;
      }>();

    if (!row) {
      await env.DB.prepare("UPDATE digests SET emailed_at = NULL WHERE id = ?1")
        .bind(digestId)
        .run();
      return;
    }

    const items = JSON.parse(row.items_json || "[]") as DigestItemData[];
    const siteUrl = env.SITE_URL || "https://news.ioenv.com";
    const { subject, text, html } = formatDigestEmail(
      {
        id: row.id,
        industryId: row.industry_id,
        industrySlug: row.industry_slug,
        industryName: row.industry_name,
        kind: row.kind,
        periodStart: row.period_start,
        publishedAt: row.published_at,
        intro: row.intro,
        items,
      },
      siteUrl,
    );

    const from = env.EMAIL_FROM || DEFAULT_EMAIL_FROM;

    await env.EMAIL.send({
      to: adminEmail,
      from,
      subject,
      text,
      html,
    });
  } catch (err) {
    // Revert claim on send error so retry can attempt again
    await env.DB.prepare("UPDATE digests SET emailed_at = NULL WHERE id = ?1")
      .bind(digestId)
      .run();
    throw err;
  }
}
