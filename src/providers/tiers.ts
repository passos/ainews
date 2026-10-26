// Gateway budget tiers (#116, decisions round 6). The one table from call
// purpose to tier. A tier belongs to the model client, not to a slot or a key:
// one slot serves several tiers, and the tier never enters a logical key, a
// request or a promptVersion.
//
//   tier N may spend while  reserved + spent + estimate + floor(N) <= cap
//   floor(N) = R1 + ... + R(N-1)       (floor(1) = 0; tier 5 has no reserve)
//
// Only the `gateway` channel has tiers; other channels use floor 0.
import type { ArtifactType } from "../lib/artifacts/types";
import { assertMicros } from "./budget";

export type Tier = 1 | 2 | 3 | 4 | 5;

/** Micro-USD kept free for each of tiers 1-4 (`budget.tier_reserves`). */
export type TierReserves = Record<"1" | "2" | "3" | "4", number>;

export const CALL_TIERS = {
  /** analyze.ts: prefilter and scoring (judge), summary (write). */
  analyze: 1,
  /** body.ts: readPage on the jina channel; recorded only. */
  body: 1,
  /** group/consumer.ts: grouping judge; the embed is on workers_ai. */
  group: 1,
  /** evidence/build.ts: claims (reason); chunk embeds are on workers_ai. */
  evidence: 3,
  /** ask/answer.ts: admin Ask. */
  adminAsk: 3,
  /** watch/evaluate.ts: judge and hit summary (write). */
  watch: 4,
  /** digest/build.ts: daily (write) and weekly (reason) digest. */
  digest: 5,
  /** discover/run.ts, discover/draft.ts. */
  discover: 5,
} as const satisfies Record<string, Tier>;

/** `revision_diff` makes no model call (src/pipeline/evidence/diff.ts). */
export const ARTIFACT_TIERS = {
  story_brief: 2,
  audience_explain: 2,
  research_paper_decoder: 4,
  learning_material: 4,
  policy_impact_explorer: 4,
  classroom_discussion_builder: 4,
  education_evidence_checker: 4,
  finance_reality_check: 4,
  regulation_watch: 4,
  finance_concept_explainer: 4,
  skills_career_trends: 4,
  industry_impact_report: 4,
  supply_chain_ripple_map: 4,
  earnings_decoder: 4,
} as const satisfies Record<Exclude<ArtifactType, "revision_diff">, Tier>;

export const TIER_LABELS: Record<Tier, string> = {
  1: "Screening, scoring, summaries, grouping",
  2: "Story Brief and explainers",
  3: "Claims, evidence, admin Ask",
  4: "Learning materials, section products, watches",
  5: "Digests, discovery",
};

/** Σ R_k for k < tier, in micro-USD. */
export function tierFloorMicros(reserves: TierReserves, tier: Tier): number {
  // A missing table entry must not read as tier "below 1" (floor 0).
  if (!Number.isInteger(tier) || tier < 1 || tier > 5) {
    throw new RangeError(`unknown budget tier ${tier}`);
  }
  let floor = 0;
  for (let k = 1; k < tier; k++) {
    const reserve = reserves[String(k) as keyof TierReserves];
    assertMicros(reserve, `tier ${k} reserve`);
    floor += reserve;
  }
  if (!Number.isSafeInteger(floor)) {
    throw new RangeError(`tier ${tier} floor is not a safe integer`);
  }
  return floor;
}
