import { dayBoundsUtc, isWeeklyDigestDue, localDate } from "../../lib/time";
import {
  sendGenerate,
  type DigestMessage,
  type PipelineEnv,
} from "../messages";

export interface EnqueueDigestOptions {
  forceWeekly?: boolean;
}

export async function enqueueDueDailyDigests(
  env: Pick<PipelineEnv, "DB">,
  now: number,
  tz: string,
  industries: { id: number }[],
): Promise<DigestMessage[]> {
  const todayStr = localDate(now, tz);
  const [todayStartMs] = dayBoundsUtc(todayStr, tz);
  const targetDate = localDate(todayStartMs - 12 * 3600 * 1000, tz);

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
  return messages;
}

export async function enqueueDueWeeklyDigests(
  env: Pick<PipelineEnv, "DB">,
  now: number,
  tz: string,
  industries: { id: number }[],
  options?: EnqueueDigestOptions,
): Promise<DigestMessage[]> {
  const weeklyDue = isWeeklyDigestDue(now, tz);
  if (!weeklyDue.due && !options?.forceWeekly) {
    return [];
  }
  const targetPeriodStart = weeklyDue.periodStart;

  const messages: DigestMessage[] = [];
  for (const ind of industries) {
    const existing = await env.DB.prepare(
      "SELECT id FROM digests WHERE industry_id = ?1 AND kind = 'weekly' AND period_start = ?2",
    )
      .bind(ind.id, targetPeriodStart)
      .first<{ id: number }>();

    if (!existing) {
      messages.push({
        kind: "digest",
        industryId: ind.id,
        digestKind: "weekly",
        periodStart: targetPeriodStart,
      });
    }
  }
  return messages;
}

export async function enqueueDueDigests(
  env: Pick<PipelineEnv, "DB" | "Q_GENERATE">,
  now: number,
  options?: EnqueueDigestOptions,
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

  // List all industries
  const { results: industries } = await env.DB.prepare(
    "SELECT id FROM industries ORDER BY id ASC",
  ).all<{ id: number }>();

  const dailyMessages = await enqueueDueDailyDigests(env, now, tz, industries);
  const weeklyMessages = await enqueueDueWeeklyDigests(
    env,
    now,
    tz,
    industries,
    options,
  );

  const messages = [...dailyMessages, ...weeklyMessages];

  if (messages.length > 0) {
    await sendGenerate(env, messages);
  }

  return messages;
}
