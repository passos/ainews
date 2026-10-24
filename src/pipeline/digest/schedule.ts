import { dayBoundsUtc, localDate } from "../../lib/time";
import {
  sendGenerate,
  type DigestMessage,
  type PipelineEnv,
} from "../messages";

export async function enqueueDueDigests(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  now: number,
): Promise<DigestMessage[]> {
  if (!env.Q_GENERATE) {
    return [];
  }

  // Read timezone from settings (default "UTC")
  const tzRow = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'digest.timezone'",
  ).first<{ value: string }>();

  let tz = "UTC";
  if (tzRow?.value) {
    try {
      const parsed = JSON.parse(tzRow.value);
      tz = typeof parsed === "string" ? parsed : tzRow.value;
    } catch {
      tz = tzRow.value;
    }
  }

  // Calculate target date = previous calendar day in this timezone
  const todayStr = localDate(now, tz);
  const [todayStartMs] = dayBoundsUtc(todayStr, tz);
  // 12 hours before midnight is safely inside the preceding day regardless of DST shifts
  const targetDate = localDate(todayStartMs - 12 * 3600 * 1000, tz);

  // List all industries
  const { results: industries } = await env.DB.prepare(
    "SELECT id FROM industries ORDER BY id ASC",
  ).all<{ id: number }>();

  const messages: DigestMessage[] = [];

  for (const ind of industries) {
    const existing = await env.DB.prepare(
      "SELECT id FROM digests WHERE industry_id = ?1 AND kind = 'daily' AND period_start = ?2",
    )
      .bind(ind.id, targetDate)
      .first<{ id: number }>();

    if (!existing) {
      messages.push({
        kind: "digest",
        industryId: ind.id,
        digestKind: "daily",
        periodStart: targetDate,
      });
    }
  }

  if (messages.length > 0) {
    await sendGenerate(env, messages);
  }

  return messages;
}
