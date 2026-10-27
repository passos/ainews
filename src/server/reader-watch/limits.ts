// Limits for reader watches (architecture §6 "读者 watch" 上限). Change the
// values in a separate PR.
export const READER_WATCH_LIMITS = {
  perNetworkPerDay: 3,
  maxActive: 200,
  judgeCallsPerDay: 500,
  neverReadMs: 3 * 86_400_000,
  unreadMs: 30 * 86_400_000,
  readTouchMs: 6 * 3_600_000,
  admissionKeepDays: 7,
} as const;
