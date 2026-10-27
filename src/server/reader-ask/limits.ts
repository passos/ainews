// Limits for public "Ask about this story" (#133). Change the values in a
// separate PR. Each question may spend up to ASK_QUESTION_MAX_COST_MICROS
// (pipeline/ask/answer.ts) of the shared gateway budget.
export const READER_ASK_LIMITS = {
  /** Public questions per UTC day, all readers together. */
  publicPerDay: 30,
} as const;
