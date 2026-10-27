export const SAFETY_FLAGS = [
  "COLLECT_ENABLED",
  "MODEL_CALLS_ENABLED",
  "EMAIL_ENABLED",
  "THIRD_PARTY_READER_ENABLED",
  "DISCOVERY_ENABLED",
  "READER_WATCH_ENABLED",
  "ASK_PUBLIC_ENABLED",
] as const;

export type SafetyFlag = (typeof SAFETY_FLAGS)[number];

/** A safety flag is on only when its value is exactly the string "true". */
export function isEnabled(
  env: Partial<Record<SafetyFlag, string | undefined>>,
  flag: SafetyFlag,
): boolean {
  return env[flag] === "true";
}
